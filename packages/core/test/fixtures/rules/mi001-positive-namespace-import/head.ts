import * as v from "vitest";
v.describe("suite", () => {
  v.it.skip("works", () => {
    v.expect(Math.max(1, 2)).toBe(2);
  });
});
