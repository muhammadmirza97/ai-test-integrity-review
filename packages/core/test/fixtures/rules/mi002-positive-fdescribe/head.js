const { add } = require("../src/math");
fdescribe("math", () => {
  test("adds", () => {
    expect(add(1, 2)).toBe(3);
  });
});
