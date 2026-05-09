import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");

export default defineConfig({
  resolve: {
    alias: [
      // Point workspace packages at their src so we don't need a rebuild between edits.
      {
        find: /^@agentry\/shared$/,
        replacement: resolve(root, "packages/shared/src/index.ts"),
      },
      {
        find: /^@agentry\/db$/,
        replacement: resolve(root, "packages/db/src/index.ts"),
      },
      {
        find: /^@agentry\/db\/schema$/,
        replacement: resolve(root, "packages/db/src/schema.ts"),
      },
      // Force the in-process Node libsql driver in tests; the api source imports
      // `@libsql/client/web` which is fine on Workers but unusable in plain Node.
      {
        find: /^@libsql\/client\/web$/,
        replacement: "@libsql/client/node",
      },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
  },
});
