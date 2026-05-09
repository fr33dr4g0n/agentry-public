import type { Config } from "drizzle-kit";

const url = process.env.TURSO_DATABASE_URL ?? "";
const authToken = process.env.TURSO_AUTH_TOKEN;

export default {
  schema: "./src/schema.ts",
  dialect: "turso",
  dbCredentials: { url, authToken },
  out: "./drizzle",
  verbose: true,
  strict: true,
} satisfies Config;
