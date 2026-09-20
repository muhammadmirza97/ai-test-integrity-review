import * as v from "vitest";
v.describe("suite", () => {
  v.it("works", () => {
    v.expect(Math.max(1, 2)).toBe(2);
  });
});
