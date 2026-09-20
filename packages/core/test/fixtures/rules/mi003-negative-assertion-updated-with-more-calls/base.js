describe("cart", () => {
  let cart;
  beforeEach(() => {
    cart = createCart();
    expect(cart.items).toEqual([]);
  });
  it("adds", () => {
    cart.add("apple");
    expect(cart.items).toEqual(["apple"]);
  });
});
