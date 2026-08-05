import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { QuarantineItem } from "../../lib/quarantine.ts";
import { QuarantineScreen } from "./QuarantineScreen.tsx";
import type { QuarantineSource } from "./source.ts";

const base: QuarantineItem = {
  id: "q1", ingestId: "a".repeat(64), receivedAt: "2026-08-01T00:00:00Z", expiresAt: "2026-08-02T00:00:00Z",
  warnedAt: "2026-08-02T00:00:00Z", deleteAfter: "2026-08-12T00:00:00Z", outerDomain: "gmail.com",
  innerDomain: "bank.ae", attested: true, attestedBy: "ARC seal", dkim: "pass", arc: "pass", sizeBucket: 1024,
};

function source(item: QuarantineItem): QuarantineSource {
  return {
    list: async () => ({ items: [item], actionNeeded: 1, expiringSoon: 1, next: {}, complete: true }),
    confirm: async () => ({ domain: "bank.ae", scope: "inner", ingestIds: [], reingest: null }),
  };
}

it("renders unauthenticated prominently and disables trust", async () => {
  await render(<QuarantineScreen source={source({ ...base, attested: false, innerDomain: "attacker.example", attestedBy: "" })} />);
  await waitFor(() => expect(screen.getByText("Unauthenticated")).toBeTruthy());
  expect(screen.queryByText("attacker.example")).toBeNull();
  expect(screen.getByText("Cannot trust unauthenticated mail").parent?.props.accessibilityState.disabled).toBe(true);
});

it("renders the actual delete_after countdown, not expires_at", async () => {
  await render(<QuarantineScreen source={source(base)} now={() => Date.parse("2026-08-03T00:00:00Z")} />);
  await waitFor(() => expect(screen.getByText("Scheduled for deletion in 9 days")).toBeTruthy());
  expect(screen.queryByText(/expired yesterday/i)).toBeNull();
  expect(screen.getByText("bank.ae")).toBeTruthy();
  expect(screen.getByText("Verification: ARC seal")).toBeTruthy();
});

it("retains held cards while paging a removal-only cursor", async () => {
  let page = 0;
  const paged: QuarantineSource = {
    list: async () => page++ === 0
      ? { items: [base], actionNeeded: 1, expiringSoon: 0, next: { removedAfter: "r", removedAfterId: "rid" }, complete: false }
      : { items: [], actionNeeded: 1, expiringSoon: 0, next: {}, complete: true },
    confirm: async () => ({ domain: "bank.ae", scope: "inner", ingestIds: [], reingest: null }),
  };
  await render(<QuarantineScreen source={paged} />);
  await waitFor(() => expect(screen.getByText("bank.ae")).toBeTruthy());
  fireEvent.press(screen.getByText("Load more"));
  await waitFor(() => expect(screen.queryByText("Load more")).toBeNull());
  expect(screen.getByText("bank.ae")).toBeTruthy();
});
