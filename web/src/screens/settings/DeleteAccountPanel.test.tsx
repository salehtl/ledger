/**
 * The delete-account screen.
 *
 * Two properties matter more than the rest, and both of them are the kind that
 * a screen can lose silently:
 *
 *  1. The destructive button cannot be reached by tapping. It needs a typed
 *     word, and until it is typed the ceremony must not run AT ALL — not "run
 *     and be refused".
 *  2. The unsent count is the REAL one, read from the outbox. A number this
 *     screen invented, or one that quietly said zero, would tell a person that
 *     nothing local is at stake on the screen where that is the one thing they
 *     cannot get back.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DeleteAccountPanel } from "./DeleteAccountPanel";
import { MotionProvider } from "../../app/MotionProvider";
import { PasskeyError } from "../../v2/session";

/** A handle whose outbox holds `pending` ops and whose device can author. */
function handleWith(pending: number, writerId: string | null = "device-1") {
  return {
    client: {
      pending: Array.from({ length: pending }, (_, i) => ({ op_id: `op-${String(i)}` })),
      get writerId(): string {
        if (writerId === null) throw new Error("this device is not set up to make changes yet");
        return writerId;
      },
    },
  } as never;
}

function show(node: React.ReactElement) {
  return render(<MotionProvider>{node}</MotionProvider>);
}

const button = () => screen.getByRole("button", { name: /delete my account/i });
const field = () => screen.getByLabelText(/type delete to confirm/i);

describe("DeleteAccountPanel", () => {
  it("says what is destroyed and that nobody can undo it, before anything is typed", () => {
    show(<DeleteAccountPanel handle={handleWith(0)} destroy={vi.fn()} wipe={vi.fn()} />);

    // On the screen, not behind a disclosure — a `getByText` that only passes
    // after a tap would be exactly the failure this asserts against.
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/nobody can bring it back/i)).toBeInTheDocument();
    // And the operator is never offered as a way back.
    expect(screen.queryByText(/contact (support|the operator)/i)).toBeNull();
    // Mail in flight.
    expect(screen.getByText(/mail sent to it after that is refused/i)).toBeInTheDocument();
  });

  it("will not run the ceremony until the word is typed", async () => {
    const destroy = vi.fn();
    const wipe = vi.fn();
    show(<DeleteAccountPanel handle={handleWith(0)} destroy={destroy} wipe={wipe} />);

    expect(button()).toBeDisabled();
    await userEvent.click(button());
    expect(destroy).not.toHaveBeenCalled();

    // A near miss is still a miss.
    await userEvent.type(field(), "delet");
    expect(button()).toBeDisabled();
    await userEvent.click(button());
    expect(destroy).not.toHaveBeenCalled();

    await userEvent.type(field(), "e");
    expect(button()).toBeEnabled();
    await userEvent.click(button());
    await waitFor(() => {
      expect(destroy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(wipe).toHaveBeenCalledTimes(1);
    });
  });

  it("shows the real number of unsent changes", () => {
    show(<DeleteAccountPanel handle={handleWith(3)} destroy={vi.fn()} wipe={vi.fn()} />);

    const notice = screen.getByTestId("delete-account-unsent");
    expect(notice).toHaveTextContent("3 changes have not been sent yet");
    expect(notice).toHaveTextContent(/on this device only/i);
    expect(screen.queryByTestId("delete-account-synced")).toBeNull();
  });

  it("reads one unsent change as one, not as a plural", () => {
    show(<DeleteAccountPanel handle={handleWith(1)} destroy={vi.fn()} wipe={vi.fn()} />);
    expect(screen.getByTestId("delete-account-unsent")).toHaveTextContent("1 change has not been sent yet");
  });

  it("says so plainly when everything has already synced", () => {
    show(<DeleteAccountPanel handle={handleWith(0)} destroy={vi.fn()} wipe={vi.fn()} />);
    expect(screen.getByTestId("delete-account-synced")).toHaveTextContent(/reached the server/i);
    expect(screen.queryByTestId("delete-account-unsent")).toBeNull();
  });

  it("refuses to try at all from a device with no writer key", async () => {
    const destroy = vi.fn();
    show(<DeleteAccountPanel handle={handleWith(0, null)} destroy={destroy} wipe={vi.fn()} />);

    expect(screen.getByTestId("delete-account-no-key")).toBeInTheDocument();
    await userEvent.type(field(), "DELETE");
    expect(button()).toBeDisabled();
    await userEvent.click(button());
    expect(destroy).not.toHaveBeenCalled();
  });

  it("says the account is intact when the server refuses, and wipes nothing", async () => {
    const destroy = vi.fn(() => Promise.reject(new PasskeyError("rejected", "no")));
    const wipe = vi.fn();
    show(<DeleteAccountPanel handle={handleWith(0)} destroy={destroy} wipe={wipe} />);

    await userEvent.type(field(), "DELETE");
    await userEvent.click(button());

    const error = await screen.findByTestId("delete-account-error");
    expect(error).toHaveTextContent(/your account has not been deleted/i);
    expect(wipe).not.toHaveBeenCalled();
    // And the button comes back, because trying again is the right thing to do.
    await waitFor(() => {
      expect(button()).toBeEnabled();
    });
  });
});
