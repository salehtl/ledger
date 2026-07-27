import { render, screen, fireEvent } from "@testing-library/react";
import { Plus } from "./PixelIcon";
import { Fab } from "./Fab";

it("renders an accessible labelled button and fires onClick", () => {
  const onClick = vi.fn();
  render(<Fab icon={Plus} label="Add transaction" onClick={onClick} />);
  const btn = screen.getByRole("button", { name: "Add transaction" });
  fireEvent.click(btn);
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("the plate is square, shadowless and flush to the content margin", () => {
  render(<Fab icon={Plus} label="Add transaction" onClick={() => {}} />);
  const el = screen.getByLabelText("Add transaction");
  expect(el.className).not.toContain("shadow-1");
  expect(el.className).not.toContain("rounded-lg");
  expect(el.className).toContain("rounded-[var(--radius-card)]");
});
