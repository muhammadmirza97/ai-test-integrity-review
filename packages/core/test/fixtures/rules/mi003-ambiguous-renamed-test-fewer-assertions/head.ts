import { describe, expect, it } from "vitest";
import { login } from "../src/auth";

describe("login", () => {
  it("returns 401 for a wrong password", async () => {
    const response = await login("alice", "wrong");
    expect(response.status).toBe(401);
  });
});
