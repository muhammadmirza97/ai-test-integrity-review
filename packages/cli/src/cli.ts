import { parseArgs } from "node:util";
import { runCheckCommand } from "./check.js";
import { runDoctorCommand } from "./doctor.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

export const USAGE = `Usage: merge-integrity <command> [options]

Commands:
  check     Analyse a pull request (base..head) and print PASS / WARN / BLOCK / ERROR
  doctor    Compatibility preflight: SUPPORTED / SUPPORTED WITH WARNINGS / UNSUPPORTED

Check options:
  --base <git-ref>                 Base revision (required)
  --head <git-ref>                 Head revision (default: HEAD)
  --working-directory <path>       Project directory relative to the repository root
  --framework auto|jest|vitest     Test framework (default: from config, else auto)
  --config <path>                  Config path relative to the repository root (default: .merge-integrity.yml)
  --config-source base|head        Revision the policy is loaded from (default: base)
  --format text|json               Output format (default: text)
  --output <path>                  Also write the JSON report to this file
  --mutation                       Enable mutation testing for this run (opt-in; requires Stryker)
  --no-mutation                    Disable mutation testing for this run
  --no-red-green                   Disable red/green verification for this run

Doctor options (compatibility preflight; run this before enforcing the check):
  --base <git-ref>  --head <git-ref>  --working-directory <path>  --framework <name>  --config <path>
  --format text|json               Output format (default: text)

Doctor verdicts: SUPPORTED (exit 0), SUPPORTED WITH WARNINGS (exit 0), UNSUPPORTED (exit 2)

Exit codes: 0 PASS (or non-blocking WARN), 1 BLOCK, 2 ERROR / unsupported / invalid configuration
`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        "working-directory": { type: "string" },
        framework: { type: "string" },
        config: { type: "string" },
        "config-source": { type: "string" },
        format: { type: "string" },
        output: { type: "string" },
        mutation: { type: "boolean" },
        "no-mutation": { type: "boolean" },
        "no-red-green": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout("merge-integrity 0.1.0-alpha.2\n");
    return 0;
  }
  const command = positionals[0];
  if (values.help || command === undefined || command === "help") {
    (command === undefined && !values.help ? io.stderr : io.stdout)(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (positionals.length > 1) {
    io.stderr(`Unexpected arguments: ${positionals.slice(1).join(" ")}\n\n${USAGE}`);
    return 2;
  }

  const framework = values.framework;
  if (framework !== undefined && framework !== "auto" && framework !== "jest" && framework !== "vitest") {
    io.stderr(`--framework must be auto, jest or vitest\n`);
    return 2;
  }

  const format = values.format ?? "text";
  if (format !== "text" && format !== "json") {
    io.stderr("--format must be text or json\n");
    return 2;
  }

  switch (command) {
    case "doctor":
      return runDoctorCommand(
        {
          cwd: io.cwd,
          format,
          ...(values.base === undefined ? {} : { baseRef: values.base }),
          ...(values.head === undefined ? {} : { headRef: values.head }),
          ...(values["working-directory"] === undefined ? {} : { workingDirectory: values["working-directory"] }),
          ...(values.config === undefined ? {} : { configPath: values.config }),
          ...(framework === undefined ? {} : { framework }),
        },
        io,
      );
    case "check": {
      const configSource = values["config-source"] ?? "base";
      if (configSource !== "base" && configSource !== "head") {
        io.stderr("--config-source must be base or head\n");
        return 2;
      }
      return runCheckCommand(
        {
          cwd: io.cwd,
          baseRef: values.base,
          headRef: values.head ?? "HEAD",
          workingDirectory: values["working-directory"],
          framework,
          configPath: values.config,
          configSource,
          format,
          output: values.output,
          mutation: values["no-mutation"] ? false : values.mutation ? true : undefined,
          redGreen: values["no-red-green"] ? false : undefined,
        },
        io,
      );
    }
    default:
      io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}
