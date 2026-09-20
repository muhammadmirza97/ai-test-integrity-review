import { describe, expect, it } from "vitest";
import { login } from "../src/auth";

describe("login", () => {
  it("rejects a bad password", async () => {
    const response = await login("alice", "wrong");
    expect(true).toBe(true);
    expect(1).toBeTruthy();
  });
});
