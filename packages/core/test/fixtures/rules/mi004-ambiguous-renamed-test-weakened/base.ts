it("returns unauthorized", () => {
  expect(check().status).toBe(401);
});
