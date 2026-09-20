import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/lib/**", "**/node_modules/**", "test-repos/**", "coverage/**", ".stryker-tmp/**", "packages/*/test/fixtures/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", Buffer: "readonly", console: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Security: untrusted values must never reach a shell.
      "no-restricted-properties": [
        "error",
        { property: "exec", object: "child_process", message: "Use runProcess (argument arrays, no shell)." },
        { property: "execSync", object: "child_process", message: "Use runProcess (argument arrays, no shell)." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message: "Spawning through a shell is forbidden; pass an argument array.",
        },
        {
          selector: "ImportDeclaration[source.value=/child_process$/] ImportSpecifier[imported.name=/^(exec|execSync)$/]",
          message: "exec/execSync build shell command strings; use runProcess.",
        },
        { selector: "CallExpression[callee.name='eval']", message: "eval is forbidden." },
        { selector: "NewExpression[callee.name='Function']", message: "new Function is forbidden." },
      ],
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["packages/core/src/process/run.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "node:child_process", message: "Only process/run.ts may spawn processes." }, { name: "child_process", message: "Only process/run.ts may spawn processes." }] },
      ],
    },
  },
);
