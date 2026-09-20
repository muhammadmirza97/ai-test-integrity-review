import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@merge-integrity/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
  "@merge-integrity/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/test/unit/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["packages/*/test/integration/**/*.test.ts"],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
