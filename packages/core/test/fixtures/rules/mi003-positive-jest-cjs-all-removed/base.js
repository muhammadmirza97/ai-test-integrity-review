const { isAdult } = require("../src/age");

test("detects adults", () => {
  expect(isAdult(18)).toBe(true);
  expect(isAdult(17)).toBe(false);
});
