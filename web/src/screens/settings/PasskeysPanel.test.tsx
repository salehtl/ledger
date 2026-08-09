/**
 * The passkey list, against the seam `V2Settings` injects.
 *
 * The server routes behind `list`/`remove` do not exist yet, so this seam IS
 * the contract the screen is built against — see `v2/passkeys.ts`. What is
 * asserted here is the spec's client rules: the current credential is
 * labelled, removal is a destructive confirm that names the consequence, and
 * at one credential the remove control is disabled WITH the reason shown, not
 * hidden.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MotionProvider } from "../../app/MotionProvider";
import type { PasskeySummary } from "../../v2/passkeys";
import { ApiError } from "@ledger/client/net/client";
import { PasskeysPanel, type PasskeysPanelProps } from "./PasskeysPanel";

const TWO: PasskeySummary[] = [
  {
    credentialId: "cred-1",
    createdAt: "2026-08-01T10:00:00Z",
    lastUsedAt: "2026-08-09T09:00:00Z",
    authenticator: "iCloud Keychain",
    current: true,
  },
  { credentialId: "cred-2", createdAt: "2026-08-05T10:00:00Z", lastUsedAt: null, authenticator: null, current: false },
];

function wrap(props: Partial<PasskeysPanelProps> = {}) {
  return render(
    <MotionProvider>
      <PasskeysPanel list={async () => TWO} remove={async () => {}} {...props} />
    </MotionProvider>,
  );
}

describe("PasskeysPanel", () => {
  it("lists each passkey with its name, dates, and a marker for this device's credential", async () => {
    wrap();
    const rows = await screen.findAllByTestId("passkey-row");
    expect(rows).toHaveLength(2);

    // The named one, marked as the credential this session stands on.
    expect(rows[0]).toHaveTextContent("iCloud Keychain");
    expect(rows[0]).toHaveTextContent("This device");
    expect(rows[0]).toHaveTextContent("Added 2026-08-01");
    expect(rows[0]).toHaveTextContent("last used 2026-08-09");

    // The unnamed one falls back to "Passkey" and says it has never signed in.
    expect(rows[1]).toHaveTextContent("Passkey");
    expect(rows[1]).not.toHaveTextContent("This device");
    expect(rows[1]).toHaveTextContent("never used to sign in");
  });

  it("removes a passkey only after a confirm that names the consequence", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => {});
    wrap({ remove });

    const rows = await screen.findAllByTestId("passkey-row");
    await user.click(within(rows[1]!).getByRole("button", { name: /remove/i }));

    // Nothing removed yet: the dialog is the decision.
    expect(remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent ?? "").toMatch(/can no longer sign in/i);

    await user.click(within(dialog).getByRole("button", { name: /remove passkey/i }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("cred-2");
    });
    // The row is gone, and with one left the remaining control locks.
    expect(screen.getAllByTestId("passkey-row")).toHaveLength(1);
    expect(screen.getByTestId("passkeys-last-reason")).toBeInTheDocument();
  });

  it("backs out of the confirm without removing anything", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => {});
    wrap({ remove });

    const rows = await screen.findAllByTestId("passkey-row");
    await user.click(within(rows[1]!).getByRole("button", { name: /remove/i }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /keep it/i }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("passkey-row")).toHaveLength(2);
  });

  it("warns extra when the passkey being removed is the one this device is signed in with", async () => {
    const user = userEvent.setup();
    wrap();
    const rows = await screen.findAllByTestId("passkey-row");
    await user.click(within(rows[0]!).getByRole("button", { name: /remove/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent ?? "").toMatch(/signed in with on this device/i);
  });

  it("disables removal at one credential and shows the reason — not hidden", async () => {
    const user = userEvent.setup();
    wrap({ list: async () => [TWO[0]!] });

    const row = (await screen.findAllByTestId("passkey-row"))[0]!;
    const remove = within(row).getByRole("button", { name: /remove/i });
    // Present AND disabled: a hidden control teaches nothing.
    expect(remove).toBeDisabled();
    expect(screen.getByTestId("passkeys-last-reason").textContent ?? "").toMatch(/only passkey/i);
    // And it really is inert.
    await user.click(remove).catch(() => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the server's own last-passkey refusal when the server refuses anyway", async () => {
    // Defence in depth is the CLIENT's disabled button; the authoritative
    // guard is the server's 409. Two stale tabs can disagree about the count,
    // so the refusal must land legibly even with two rows showing.
    const user = userEvent.setup();
    wrap({
      remove: async () => {
        throw new ApiError(409, "last_passkey", "", "DELETE: 409 last_passkey");
      },
    });

    const rows = await screen.findAllByTestId("passkey-row");
    await user.click(within(rows[1]!).getByRole("button", { name: /remove/i }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /remove passkey/i }));
    expect((await screen.findByTestId("passkeys-remove-note")).textContent ?? "").toMatch(/only passkey/i);
    // Nothing was dropped from the list on a refusal.
    expect(screen.getAllByTestId("passkey-row")).toHaveLength(2);
  });

  it("keeps the list on a failed removal and says nothing changed", async () => {
    const user = userEvent.setup();
    wrap({
      remove: async () => {
        throw new Error("boom");
      },
    });
    const rows = await screen.findAllByTestId("passkey-row");
    await user.click(within(rows[1]!).getByRole("button", { name: /remove/i }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /remove passkey/i }));
    expect((await screen.findByTestId("passkeys-remove-note")).textContent ?? "").toMatch(/nothing changed/i);
    expect(screen.getAllByTestId("passkey-row")).toHaveLength(2);
  });

  it("shows an honest error state when the list cannot be read, and retries", async () => {
    // This is the state production shows until the Go endpoints exist.
    const user = userEvent.setup();
    let calls = 0;
    wrap({
      list: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(404, "not_found", "", "GET: 404");
        return TWO;
      },
    });
    expect(await screen.findByTestId("passkeys-error")).toHaveTextContent(/could not read your passkeys/i);
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findAllByTestId("passkey-row")).toHaveLength(2);
  });
});
