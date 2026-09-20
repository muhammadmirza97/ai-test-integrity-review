import { describe, expect, it } from "vitest";
import { login } from "../src/auth";
import { expectUnauthorized } from "./helpers";

describe("login", () => {
  it("rejects a bad password", async () => {
    const response = await login("alice", "wrong");
    expectUnauthorized(response);
  });
});
