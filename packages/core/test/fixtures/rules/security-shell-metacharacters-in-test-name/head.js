test.only("$(touch /tmp/pwned); `id` && rm -rf / || echo \"; exit 0", () => {
  expect(JSON.parse("1")).toBe(1);
});
