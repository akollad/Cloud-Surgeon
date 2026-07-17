/**
 * surgeon-config.ts
 *
 * Loads cloud-surgeon.config.yaml and provides typed access to every
 * infrastructure topology value that was previously hardcoded.
 *
 * Priority (highest → lowest):
 *   1. cloud-surgeon.config.yaml  (topology — services, regions, patterns)
 *   2. Environment variables       (secrets + runtime overrides)
 *   3. Built-in defaults           (safe fallbacks so the server starts even
 *                                   without a config file)
 *
 * Secrets (API keys, DB passwords) NEVER go in the YAML file — they stay
 * in env vars. This module never reads or exposes them.
 */

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EcsServiceDef {
  name: string;
  description?: string;
  aliases: string[];
  default?: boolean;
}

export interface LambdaFunctionDef {
  name: string;
  description?: string;
  aliases: string[];
  default?: boolean;
}

export interface AlertPatternRule {
  /** OR logic — any keyword present in alert text triggers this rule */
  match?: string[];
  /** AND logic — ALL keywords must be present */
  match_all?: string[];
  strategy: string;
}

export interface SurgeonConfig {
  infrastructure: {
    aws: {
      region: string;
      ecs: {
        cluster: string;
        services: EcsServiceDef[];
      };
      lambda: {
        functions: LambdaFunctionDef[];
      };
      rds: {
        instance_identifier: string | null;
      };
    };
    database: {
      provider: "cockroachdb" | "rds-postgres" | "rds-mysql";
      display_name: string;
    };
  };
  alert_patterns: AlertPatternRule[];
  routing: {
    autonomous_threshold: number;
    calibration_threshold: number;
  };
}

// ── Default config (used when no YAML file is found) ─────────────────────────

function buildDefaults(): SurgeonConfig {
  return {
    infrastructure: {
      aws: {
        region: process.env.AWS_REGION ?? "us-east-1",
        ecs: {
          cluster: process.env.ECS_DEFAULT_CLUSTER ?? "cloud-surgeon",
          services: [
            {
              name: process.env.ECS_DEFAULT_SERVICE ?? "api",
              aliases: [],
              default: true,
            },
          ],
        },
        lambda: {
          functions: [
            {
              name: process.env.LAMBDA_DEFAULT_FUNCTION ?? "lambda/unknown",
              aliases: [],
              default: true,
            },
          ],
        },
        rds: {
          instance_identifier: process.env.RDS_INSTANCE_IDENTIFIER ?? null,
        },
      },
      database: {
        provider: "cockroachdb",
        display_name: "db",
      },
    },
    alert_patterns: [],
    routing: {
      autonomous_threshold: Number(process.env.AUTONOMOUS_THRESHOLD ?? 0.80),
      calibration_threshold: Number(process.env.CALIBRATION_THRESHOLD ?? 0.15),
    },
  };
}

// ── YAML loader ───────────────────────────────────────────────────────────────

function findConfigFile(): string | null {
  const candidates = [
    process.env.CLOUD_SURGEON_CONFIG,
    path.join(process.cwd(), "cloud-surgeon.config.yaml"),
    // When running from artifacts/api-server/dist/, walk up to the artifact root
    path.resolve(process.cwd(), "..", "cloud-surgeon.config.yaml"),
    path.resolve(process.cwd(), "../..", "cloud-surgeon.config.yaml"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function deepMerge(defaults: SurgeonConfig, yaml: Partial<SurgeonConfig>): SurgeonConfig {
  // Deep merge: YAML values override defaults, missing YAML keys use defaults.
  const merged = JSON.parse(JSON.stringify(defaults)) as SurgeonConfig;

  if (yaml.infrastructure?.aws?.region) {
    merged.infrastructure.aws.region = yaml.infrastructure.aws.region;
  }
  // Env var AWS_REGION always wins over YAML for runtime flexibility
  if (process.env.AWS_REGION) {
    merged.infrastructure.aws.region = process.env.AWS_REGION;
  }

  if (yaml.infrastructure?.aws?.ecs?.cluster) {
    merged.infrastructure.aws.ecs.cluster = yaml.infrastructure.aws.ecs.cluster;
  }
  if (process.env.ECS_DEFAULT_CLUSTER) {
    merged.infrastructure.aws.ecs.cluster = process.env.ECS_DEFAULT_CLUSTER;
  }

  if (yaml.infrastructure?.aws?.ecs?.services?.length) {
    merged.infrastructure.aws.ecs.services = yaml.infrastructure.aws.ecs.services.map(s => ({
      ...s,
      aliases: s.aliases ?? [],
    }));
  }

  if (yaml.infrastructure?.aws?.lambda?.functions?.length) {
    merged.infrastructure.aws.lambda.functions = yaml.infrastructure.aws.lambda.functions.map(f => ({
      ...f,
      aliases: f.aliases ?? [],
    }));
  }

  // Env var RDS_INSTANCE_IDENTIFIER wins over YAML
  const rdsFromEnv = process.env.RDS_INSTANCE_IDENTIFIER ?? null;
  const rdsFromYaml = yaml.infrastructure?.aws?.rds?.instance_identifier ?? null;
  merged.infrastructure.aws.rds.instance_identifier = rdsFromEnv ?? rdsFromYaml;

  if (yaml.infrastructure?.database) {
    merged.infrastructure.database = {
      ...merged.infrastructure.database,
      ...yaml.infrastructure.database,
    };
  }

  if (yaml.alert_patterns?.length) {
    merged.alert_patterns = yaml.alert_patterns;
  }

  if (yaml.routing) {
    merged.routing = {
      autonomous_threshold: yaml.routing.autonomous_threshold ?? merged.routing.autonomous_threshold,
      calibration_threshold: yaml.routing.calibration_threshold ?? merged.routing.calibration_threshold,
    };
  }

  return merged;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _config: SurgeonConfig | null = null;
let _configPath: string | null = null;

export function getSurgeonConfig(): SurgeonConfig {
  if (_config) return _config;

  const defaults = buildDefaults();
  const yamlPath = findConfigFile();

  if (!yamlPath) {
    console.warn(
      "[cloud-surgeon] No cloud-surgeon.config.yaml found — " +
      "using env-var defaults. Create cloud-surgeon.config.yaml to declare " +
      "your infrastructure topology.",
    );
    _config = defaults;
    return _config;
  }

  try {
    const raw = fs.readFileSync(yamlPath, "utf8");
    const yaml = parse(raw) as Partial<SurgeonConfig>;
    _config = deepMerge(defaults, yaml);
    _configPath = yamlPath;
    console.info(`[cloud-surgeon] Config loaded from ${yamlPath}`);
  } catch (err) {
    console.error(`[cloud-surgeon] Failed to parse ${yamlPath}:`, err);
    _config = defaults;
  }

  return _config;
}

export function getConfigPath(): string | null {
  getSurgeonConfig(); // ensure loaded
  return _configPath;
}

// ── Helpers used by cloud-surgeon.ts and server.ts ───────────────────────────

/** ECS cluster name (YAML > ECS_DEFAULT_CLUSTER env var > "cloud-surgeon") */
export function ecsCluster(): string {
  return getSurgeonConfig().infrastructure.aws.ecs.cluster;
}

/** Default ECS service name (the one marked default: true) */
export function ecsDefaultService(): string {
  const svcs = getSurgeonConfig().infrastructure.aws.ecs.services;
  return svcs.find(s => s.default)?.name ?? svcs[0]?.name ?? "api";
}

/** Default fallback ref as "cluster/service" */
export function ecsDefaultRef(): string {
  return `${ecsCluster()}/${ecsDefaultService()}`;
}

/** All known ECS service names (including aliases) → real name.
 *  Returns null if the candidate doesn't match any known service. */
export function resolveEcsService(candidate: string): string | null {
  const lower = candidate.toLowerCase();
  const svcs = getSurgeonConfig().infrastructure.aws.ecs.services;
  for (const svc of svcs) {
    if (svc.name.toLowerCase() === lower) return svc.name;
    if (svc.aliases.some(a => lower.includes(a.toLowerCase()) || a.toLowerCase().includes(lower))) {
      return svc.name;
    }
  }
  return null;
}

/** All known Lambda function names + aliases → real function name.
 *  Returns null if no match found. */
export function resolveLambdaFunction(candidate: string): string | null {
  const lower = candidate.toLowerCase();
  const fns = getSurgeonConfig().infrastructure.aws.lambda.functions;
  for (const fn of fns) {
    if (fn.name.toLowerCase() === lower) return fn.name;
    if (fn.aliases.some(a => lower.includes(a.toLowerCase()) || a.toLowerCase().includes(lower))) {
      return fn.name;
    }
  }
  return null;
}

/** Default Lambda function (the one marked default: true) */
export function lambdaDefaultFunction(): string {
  const fns = getSurgeonConfig().infrastructure.aws.lambda.functions;
  return fns.find(f => f.default)?.name ?? fns[0]?.name ?? "lambda/unknown";
}

/** Whether an RDS instance is configured */
export function hasRdsConfigured(): boolean {
  return Boolean(getSurgeonConfig().infrastructure.aws.rds.instance_identifier);
}

/** RDS instance identifier (or null) */
export function rdsInstanceId(): string | null {
  return getSurgeonConfig().infrastructure.aws.rds.instance_identifier;
}

/**
 * Match alertText against the alert_patterns in config.
 * Returns the strategy name on first match, or null if no pattern matched.
 *
 * match     → OR logic  (any keyword present → match)
 * match_all → AND logic (all keywords present → match)
 */
export function matchAlertPattern(alertText: string): string | null {
  const t = alertText.toLowerCase();
  for (const rule of getSurgeonConfig().alert_patterns) {
    if (rule.match_all?.length) {
      if (rule.match_all.every(kw => t.includes(kw.toLowerCase()))) {
        return rule.strategy;
      }
    } else if (rule.match?.length) {
      if (rule.match.some(kw => t.includes(kw.toLowerCase()))) {
        return rule.strategy;
      }
    }
  }
  return null;
}

/** All known service names (ECS + Lambda) — used for "available services" hints */
export function allKnownServiceNames(): string[] {
  const cfg = getSurgeonConfig();
  const ecs = cfg.infrastructure.aws.ecs.services.map(s => s.name);
  const lambda = cfg.infrastructure.aws.lambda.functions.map(f => f.name);
  return [...ecs, ...lambda];
}
