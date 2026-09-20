#!/usr/bin/env node
import { installInterruptCleanup } from "@merge-integrity/core";
import { runCli } from "./cli.js";

installInterruptCleanup();

runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Merge Integrity: ERROR\nUnexpected failure: ${(error as Error)?.message ?? String(error)}\n`);
    process.exitCode = 2;
  },
);
