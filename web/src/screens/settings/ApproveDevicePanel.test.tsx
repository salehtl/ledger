import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApproveDevicePanel } from "./ApproveDevicePanel";
import {
  comparisonCode,
  encodeEnrolmentRequest,
  type EnrolmentRequest,
  type KeyHistoryEntry,
} from "../../v2/deviceEnrolment";
import { EnrollmentError } from "../../v2/session";

const PEER: EnrolmentRequest = {
  writerId: "web-second",
  publicKey: new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff),
};
const CODE = encodeEnrolmentRequest(PEER);

const LOG: KeyHistoryEntry[] = [
  { id: 1, writer_id: "ingest", pubkey: "", event: "registered", at: "2026-08-01T00:00:00Z" },
  { id: 2, writer_id: "web-first", pubkey: "AAECAwQFBgcICQoLDA0ODw==", event: "registered", at: "2026-08-01T00:01:00Z" },
];

function mount(over: Partial<React.ComponentProps<typeof ApproveDevicePanel>> = {}) {
  const approve = vi.fn(async (_request: EnrolmentRequest) => {});
  render(
    <ApproveDevicePanel loadKeyHistory={async () => LOG} approve={approve} {...over} />,
  );
  return { approve };
}

describe("ApproveDevicePanel", () => {
  it("will not approve before a code has been entered", () => {
    mount();
    expect(screen.getByTestId("approve-device")).toBeDisabled();
  });

  it("says what is wrong with a code rather than sending it", async () => {
    const { approve } = mount();
    await userEvent.type(screen.getByTestId("device-code-input"), "nonsense");
    expect(await screen.findByTestId("device-code-error")).toHaveTextContent(/not a ledger device code/i);
    expect(screen.getByTestId("approve-device")).toBeDisabled();
    expect(approve).not.toHaveBeenCalled();
  });

  /**
   * The security claim, tested directly: the code this device shows is derived
   * from the key history IT fetched plus the key it is about to sign for, so it
   * equals what the other device computes for itself.
   */
  it("shows the same comparison code the other device computes", async () => {
    mount();
    await userEvent.type(screen.getByTestId("device-code-input"), CODE);
    expect(await screen.findByTestId("approve-comparison-code")).toHaveTextContent(comparisonCode(PEER, LOG));
  });

  it("refuses to approve until the person confirms the two screens match", async () => {
    const { approve } = mount();
    await userEvent.type(screen.getByTestId("device-code-input"), CODE);
    await screen.findByTestId("approve-comparison-code");
    expect(screen.getByTestId("approve-device")).toBeDisabled();

    await userEvent.click(screen.getByTestId("comparison-confirm"));
    expect(screen.getByTestId("approve-device")).toBeEnabled();
    await userEvent.click(screen.getByTestId("approve-device"));
    await waitFor(() => {
      expect(approve).toHaveBeenCalledTimes(1);
    });
    const signed = approve.mock.calls[0]![0];
    expect(signed.writerId).toBe(PEER.writerId);
    expect(Array.from(signed.publicKey)).toEqual(Array.from(PEER.publicKey));
    expect(await screen.findByTestId("approve-device-done")).toBeInTheDocument();
  });

  /**
   * A check that did not happen must not be dressed up as one that did. With no
   * key history there is no comparison code, so there is no confirmation to give
   * and the button stays dead.
   */
  it("will not approve at all when it could not derive the comparison code", async () => {
    const { approve } = mount({
      loadKeyHistory: async () => {
        throw new Error("offline");
      },
    });
    await userEvent.type(screen.getByTestId("device-code-input"), CODE);
    expect(await screen.findByTestId("approve-no-code")).toBeInTheDocument();
    expect(screen.queryByTestId("comparison-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("approve-device")).toBeDisabled();
    expect(approve).not.toHaveBeenCalled();
  });

  it("re-arms the confirmation when the code is edited", async () => {
    mount();
    await userEvent.type(screen.getByTestId("device-code-input"), CODE);
    await userEvent.click(await screen.findByTestId("comparison-confirm"));
    expect(screen.getByTestId("approve-device")).toBeEnabled();
    await userEvent.type(screen.getByTestId("device-code-input"), "x");
    expect(screen.getByTestId("approve-device")).toBeDisabled();
  });

  /**
   * The refusal is written for the APPROVER. `enrollmentCopy`'s `rejected` arm
   * is written for the device being added — "this device cannot make changes
   * until a device that is already signed in approves it, use the code below" —
   * and on this screen every clause of it is false. Asserting the borrowed copy
   * is what would lock the wrong sentence in, so this asserts the panel's own
   * and asserts the borrowed one is absent.
   */
  it("reports a refusal in words true for the person approving, and stays usable", async () => {
    mount({
      approve: async () => {
        throw new EnrollmentError("rejected", "403");
      },
    });
    await userEvent.type(screen.getByTestId("device-code-input"), CODE);
    await userEvent.click(await screen.findByTestId("comparison-confirm"));
    await userEvent.click(screen.getByTestId("approve-device"));
    const note = await screen.findByTestId("approve-failure");
    expect(note).toHaveTextContent(/That device was not added/i);
    // The two 403s that can actually arrive: already enrolled
    // (ErrWriterExists / ErrKeyAlreadyEnrolled) and this device's key no longer
    // accepted (ErrNotAuthorized).
    expect(note).toHaveTextContent(/already added/i);
    expect(note).toHaveTextContent(/key is no longer accepted/i);
    // The enrolling device's sentences, which would be false here.
    expect(note).not.toHaveTextContent(/needs approval/i);
    expect(note).not.toHaveTextContent(/code below/i);
    // And the causes that cannot happen. Nothing here goes stale — the nonce is
    // minted seconds before the register, and the pasted code never expires —
    // and a fresh code re-registers the identical writer id and key, so it
    // cures neither real cause. Naming it would prescribe the one action that
    // cannot work.
    expect(note).not.toHaveTextContent(/stale/i);
    expect(note).not.toHaveTextContent(/fresh code/i);
    expect(screen.getByTestId("approve-device")).toBeEnabled();
  });

  /**
   * `V2Handle.approveDevice` refuses locally, BEFORE any request, when this
   * device holds no enrolled writer of its own. Nothing was asked of the
   * server, so nothing may be reported as the server's answer.
   */
  it("does not blame the server for a refusal this device made by itself", async () => {
    mount({
      approve: async () => {
        throw new EnrollmentError("key_lost", "this device is not enrolled itself");
      },
    });
    await userEvent.type(screen.getByTestId("device-code-input"), CODE);
    await userEvent.click(await screen.findByTestId("comparison-confirm"));
    await userEvent.click(screen.getByTestId("approve-device"));
    const note = await screen.findByTestId("approve-failure");
    expect(note).toHaveTextContent(/has not been set up to make changes itself/i);
    expect(note).not.toHaveTextContent(/server/i);
    expect(note).not.toHaveTextContent(/fresh code/i);
  });

  it("says the connection failed when that is what happened, and never blames the code", async () => {
    mount({
      approve: async () => {
        throw new EnrollmentError("offline", "no connection");
      },
    });
    await userEvent.type(screen.getByTestId("device-code-input"), CODE);
    await userEvent.click(await screen.findByTestId("comparison-confirm"));
    await userEvent.click(screen.getByTestId("approve-device"));
    const note = await screen.findByTestId("approve-failure");
    expect(note).toHaveTextContent(/could not reach the server/i);
    expect(note).not.toHaveTextContent(/fresh code/i);
  });
});
