const { isAdult } = require("../src/age");

test("detects adults", () => {
  isAdult(18);
});
