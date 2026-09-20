import { describe, expect, it } from "vitest";
import { detectFramework, type ProjectFileReader } from "../../src/framework/detect.js";

function reader(files: Record<string, string>): ProjectFileReader {
  return {
    readText: async (path) => files[path],
    exists: async (path) => path in files,
  };
}

describe("detectFramework", () => {
  it("detects Jest from devDependencies", async () => {
    const result = await detectFramework(
      reader({ "package.json": JSON.stringify({ devDependencies: { jest: "^30.0.0" }, scripts: { test: "jest" } }) }),
    );
    expect(result.kind).toBe("jest");
  });

  it("detects Vitest from devDependencies", async () => {
    const result = await detectFramework(
      reader({ "package.json": JSON.stringify({ devDependencies: { vitest: "^5.0.0" }, scripts: { test: "vitest run" } }) }),
    );
    expect(result.kind).toBe("vitest");
  });

  it("detects Vitest from a config file", async () => {
    const result = await detectFramework(reader({ "package.json": "{}", "vitest.config.ts": "export default {}" }));
    expect(result.kind).toBe("vitest");
  });

  it("uses the test script to disambiguate when both are declared", async () => {
    const result = await detectFramework(
      reader({
        "package.json": JSON.stringify({ devDependencies: { jest: "1", vitest: "1" }, scripts: { test: "vitest run" } }),
      }),
    );
    expect(result.kind).toBe("vitest");
  });

  it("reports ambiguity instead of guessing", async () => {
    const result = await detectFramework(
      reader({
        "package.json": JSON.stringify({ devDependencies: { jest: "1", vitest: "1" }, scripts: { test: "jest && vitest" } }),
      }),
    );
    expect(result.kind).toBe("ambiguous");
  });

  it("reports unsupported projects explicitly", async () => {
    const result = await detectFramework(
      reader({ "package.json": JSON.stringify({ devDependencies: { mocha: "1" }, scripts: { test: "mocha" } }) }),
    );
    expect(result.kind).toBe("unsupported");
  });

  it("reports a missing or malformed package.json as unsupported", async () => {
    expect((await detectFramework(reader({}))).kind).toBe("unsupported");
    expect((await detectFramework(reader({ "package.json": "{not json" }))).kind).toBe("unsupported");
    expect((await detectFramework(reader({ "package.json": "[]" }))).kind).toBe("unsupported");
  });

  it("honours an explicit framework but still requires evidence for it", async () => {
    const files = reader({ "package.json": JSON.stringify({ devDependencies: { jest: "1" } }) });
    expect((await detectFramework(files, "jest")).kind).toBe("jest");
    expect((await detectFramework(files, "vitest")).kind).toBe("unsupported");
  });

  it("explicit framework resolves an ambiguous project", async () => {
    const files = reader({ "package.json": JSON.stringify({ devDependencies: { jest: "1", vitest: "1" } }) });
    expect((await detectFramework(files, "vitest")).kind).toBe("vitest");
  });
});
