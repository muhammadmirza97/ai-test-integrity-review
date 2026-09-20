import { describe, expect, it } from "vitest";
import { login } from "../src/auth";

describe("login", () => {
  it.only("rejects a bad password", async () => {
    const response = await login("alice", "wrong");
    expect(response.status).toBe(401);
  });
});
