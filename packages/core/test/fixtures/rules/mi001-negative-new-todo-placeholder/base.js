const { add } = require("../src/math");
describe("math", () => {
  test("adds", () => {
    expect(add(1, 2)).toBe(3);
  });
});
