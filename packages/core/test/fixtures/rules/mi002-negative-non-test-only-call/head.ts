import { describe, expect, it } from "vitest";
import { login } from "../src/auth";
import { query } from "../src/db";

describe("login", () => {
  it("rejects a bad password", async () => {
    const response = await login("alice", "wrong");
    expect(response.status).toBe(401);
    expect(query.only(["id"]).fields).toEqual(["id"]);
  });
});
