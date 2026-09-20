describe("db", () => {
  afterEach(() => {
    openConnections();
  });
  it("queries", () => {
    expect(query("select 1")).toEqual([1]);
  });
});
