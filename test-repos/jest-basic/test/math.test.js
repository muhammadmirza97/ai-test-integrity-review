const { add, isAdult } = require("../src/math");

describe("math", () => {
  it("adds numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("detects adults", () => {
    expect(isAdult(18)).toBe(true);
    expect(isAdult(17)).toBe(false);
  });
});
