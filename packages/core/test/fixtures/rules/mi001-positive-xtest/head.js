const { add } = require("../src/math");
describe("math", () => {
  xtest("adds", () => {
    expect(add(1, 2)).toBe(3);
  });
});
