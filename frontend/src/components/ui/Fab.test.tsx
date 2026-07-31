import { render, screen, fireEvent } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { Plus } from "./PixelIcon";
import { Fab } from "./Fab";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

it("renders an accessible labelled button and fires onClick", () => {
  const onClick = vi.fn();
  wrap(<Fab icon={Plus} label="Add transaction" onClick={onClick} />);
  const btn = screen.getByRole("button", { name: "Add transaction" });
  fireEvent.click(btn);
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("the plate is square, shadowless and flush to the content margin", () => {
  wrap(<Fab icon={Plus} label="Add transaction" onClick={() => {}} />);
  const el = screen.getByLabelText("Add transaction");
  expect(el.className).not.toContain("shadow-1");
  expect(el.className).toContain("rounded-[var(--radius)]");
});
