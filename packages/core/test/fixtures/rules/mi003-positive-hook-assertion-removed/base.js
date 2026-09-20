describe("db", () => {
  afterEach(() => {
    expect(openConnections()).toBe(0);
  });
  it("queries", () => {
    expect(query("select 1")).toEqual([1]);
  });
});
