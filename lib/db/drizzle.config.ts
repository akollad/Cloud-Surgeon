import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.COCKROACHDB_URL) {
  throw new Error("COCKROACHDB_URL, ensure the CockroachDB cluster is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.COCKROACHDB_URL,
  },
});
