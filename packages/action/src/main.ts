import { installInterruptCleanup } from "@merge-integrity/core";
import { runAction } from "./run.js";

installInterruptCleanup();

runAction({ env: process.env, stdout: (text) => process.stdout.write(text) }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stdout.write(`::error title=Merge Integrity: ERROR::unexpected failure: ${String((error as Error)?.message ?? error).replace(/[\r\n%]/g, " ")}\n`);
    process.exitCode = 2;
  },
);
