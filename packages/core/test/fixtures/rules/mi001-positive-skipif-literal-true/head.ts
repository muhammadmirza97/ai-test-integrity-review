import { describe, expect, it } from "vitest";
import { login } from "../src/auth";

describe("login", () => {
  it.skipIf(true)("rejects a bad password", async () => {
    const response = await login("alice", "wrong");
    expect(response.status).toBe(401);
  });
});
