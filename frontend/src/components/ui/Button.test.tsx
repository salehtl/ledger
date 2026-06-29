import { render, screen } from "@testing-library/react";
import { Button } from "./Button";

it("applies press-feedback class for tactile :active scaling", () => {
  render(<Button>Save</Button>);
  expect(screen.getByRole("button", { name: "Save" }).className).toContain("press");
});
