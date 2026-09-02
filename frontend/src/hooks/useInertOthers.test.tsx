import { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useInertOthers } from "./useInertOthers";

function Sheet({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useInertOthers(ref);
  return <div ref={ref} data-testid="sheet">{children}</div>;
}

const inert = (el: Element | null) => el?.hasAttribute("inert") ?? false;

describe("useInertOthers", () => {
  it("inerts every sibling along the path to the root, and nothing inside the sheet", () => {
    const { container, unmount } = render(
      <div data-testid="app">
        <button data-testid="behind">behind</button>
        <div data-testid="wrap">
          <nav data-testid="nav" />
          <Sheet><button data-testid="inside">inside</button></Sheet>
        </div>
      </div>,
    );
    const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    expect(inert(q("behind"))).toBe(true);
    expect(inert(q("nav"))).toBe(true);
    expect(inert(q("wrap"))).toBe(false); // an ancestor of the sheet must stay live
    expect(inert(q("app"))).toBe(false);
    expect(inert(q("sheet"))).toBe(false);
    expect(inert(q("inside"))).toBe(false);
    unmount();
    expect(inert(q("behind"))).toBe(false);
    expect(inert(q("nav"))).toBe(false);
  });

  it("leaves an element the app already made inert alone on cleanup", () => {
    const Host = ({ open }: { open: boolean }) => (
      <div>
        <div data-testid="already" inert />
        {open && <Sheet />}
      </div>
    );
    const { container, rerender } = render(<Host open />);
    const already = () => container.querySelector('[data-testid="already"]');
    expect(inert(already())).toBe(true);
    rerender(<Host open={false} />);
    expect(inert(already())).toBe(true);
  });

  it("ref-counts across nested sheets, so closing the inner one keeps the outer's siblings inert", () => {
    function Host({ inner }: { inner: boolean }) {
      return (
        <div>
          <button data-testid="behind">behind</button>
          <Sheet>{inner && <Sheet />}</Sheet>
        </div>
      );
    }
    const { container, rerender } = render(<Host inner />);
    const behind = () => container.querySelector('[data-testid="behind"]');
    expect(inert(behind())).toBe(true);
    rerender(<Host inner={false} />);
    expect(inert(behind())).toBe(true);
    rerender(<div><button data-testid="behind">behind</button></div>);
    expect(inert(behind())).toBe(false);
  });

  it("skips a sibling marked data-inert-exempt (the toast region)", () => {
    const { container } = render(
      <div>
        <div data-testid="toasts" data-inert-exempt="" />
        <Sheet />
      </div>,
    );
    expect(inert(container.querySelector('[data-testid="toasts"]'))).toBe(false);
  });
});
