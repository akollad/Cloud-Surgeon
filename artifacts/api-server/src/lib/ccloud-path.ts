/**
 * Resolves the ccloud binary path for the current environment.
 *
 * Production (ECS / Docker): the binary is copied to /usr/local/bin/ccloud
 *   by the Dockerfile's dedicated `ccloud` build stage.
 *
 * Development (Replit / local): the binary lives at <workspace-root>/.tools/ccloud
 *   (persisted in the repo so the dev environment works without a separate install step).
 *
 * All routes and MCP server import from here — never compute the path inline.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CCLOUD_BINARY: string =
  process.env.NODE_ENV === "production"
    ? "/usr/local/bin/ccloud"
    : // dev: dist/lib/ → dist/ → artifacts/api-server/ → artifacts/ → workspace-root/
      path.resolve(__dirname, "..", "..", "..", ".tools", "ccloud");
