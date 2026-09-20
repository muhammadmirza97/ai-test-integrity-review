import { describe, expect, it } from "vitest";
import { login } from "../src/auth";

// TODO: it.skip("rejects a bad password") was considered but rejected.
const note = "use it.skip or describe.only when debugging locally";

describe("login", () => {
  it("rejects a bad password", async () => {
    const response = await login("alice", "wrong");
    expect(response.status).toBe(401);
    expect(note).toContain("it.skip");
  });
});
