import { render, screen, fireEvent } from "@testing-library/react";
import { Plus } from "lucide-react";
import { Fab } from "./Fab";

it("renders an accessible labelled button and fires onClick", () => {
  const onClick = vi.fn();
  render(<Fab icon={Plus} label="Add transaction" onClick={onClick} />);
  const btn = screen.getByRole("button", { name: "Add transaction" });
  fireEvent.click(btn);
  expect(onClick).toHaveBeenCalledTimes(1);
});
