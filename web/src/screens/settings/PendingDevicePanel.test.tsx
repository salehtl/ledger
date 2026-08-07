import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PendingDevicePanel } from "./PendingDevicePanel";
import { comparisonCode, type EnrolmentRequest, type KeyHistoryEntry } from "../../v2/deviceEnrolment";

const REQ: EnrolmentRequest = {
  writerId: "web-second",
  publicKey: new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff),
};
const LOG: KeyHistoryEntry[] = [
  { id: 1, writer_id: "ingest", pubkey: "", event: "registered", at: "2026-08-01T00:00:00Z" },
];

describe("PendingDevicePanel", () => {
  it("shows a code that carries only the writer id and the public key", async () => {
    render(<PendingDevicePanel request={REQ} loadKeyHistory={async () => LOG} onRecheck={() => {}} copy={async () => {}} />);
    expect(screen.getByTestId("enrolment-code")).toHaveTextContent("ledger-device-1:web-second:");
    expect(await screen.findByText(comparisonCode(REQ, LOG))).toBeInTheDocument();
  });

  it("copies the code", async () => {
    const copy = vi.fn(async () => {});
    render(<PendingDevicePanel request={REQ} loadKeyHistory={async () => LOG} onRecheck={() => {}} copy={copy} />);
    await userEvent.click(screen.getByRole("button", { name: /copy code/i }));
    expect(copy).toHaveBeenCalledWith(screen.getByTestId("enrolment-code").textContent);
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  /**
   * A comparison code that could not be derived shows NOTHING in its place. A
   * placeholder where a security check belongs is worse than an absent one:
   * the person compares two dashes and concludes they match.
   */
  it("shows no code at all when it could not derive one, and says why", async () => {
    render(
      <PendingDevicePanel
        request={REQ}
        loadKeyHistory={async () => {
          throw new Error("offline");
        }}
        onRecheck={() => {}}
        copy={async () => {}}
      />,
    );
    expect(await screen.findByText(/could not work out the check code/i)).toBeInTheDocument();
    expect(screen.queryByText(comparisonCode(REQ, LOG))).not.toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("re-checks the roster on demand, because nothing tells this device it was approved", async () => {
    const onRecheck = vi.fn();
    render(<PendingDevicePanel request={REQ} loadKeyHistory={async () => LOG} onRecheck={onRecheck} copy={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
