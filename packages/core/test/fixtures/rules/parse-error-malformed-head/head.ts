import { describe, expect, it } from "vitest";
import { login } from "../src/auth";

describe("login", () => {
  it("rejects a bad password", async () => {
    const response = await login("alice", "wrong");
    expect(response.status).toBe(401;
    expect(response.body.error).toEqual("invalid_credentials");
  });
});
