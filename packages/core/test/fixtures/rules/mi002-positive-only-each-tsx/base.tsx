import { render } from "@testing-library/react";
import { Button } from "../src/Button";

describe("Button", () => {
  test.each([["primary"], ["secondary"]])("renders %s", (variant: string) => {
    const view = render(<Button variant={variant} />);
    expect(view.container.firstChild).toMatchSnapshot();
  });
});
