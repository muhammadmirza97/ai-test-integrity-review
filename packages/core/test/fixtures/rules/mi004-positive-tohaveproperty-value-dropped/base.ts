import { expect, it, vi } from "vitest";
import { handler } from "../src/handler";

it("handles the request", async () => {
  const response = await handler(request);
  expect(response.body).toHaveProperty("role", "admin");
});
