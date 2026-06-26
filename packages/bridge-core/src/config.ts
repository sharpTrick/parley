import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * The single config object that drives a bridge (DESIGN §11). Sane defaults everywhere.
 * `backend_config` is opaque to core and passed verbatim to the plugin's `connect()`.
 */
export const ConfigSchema = z.object({
  /** Which backend plugin to load. v0.1 ships only local-sqlite. */
  backend: z.string().default('local-sqlite'),
  /** Read-state namespace; defaults to identity.handle. Distinct sessions sharing a handle
   *  MUST set distinct instance_ids (DESIGN §10). */
  instance_id: z.string().optional(),
  /** Override the read-state file path (default: XDG_STATE_HOME/parley/<instance>/read-state.json). */
  state_path: z.string().optional(),
  identity: z.object({
    handle: z.string().min(1),
  }),
  /** Topics to subscribe to / catch up on. THIS IS THE ALLOWLIST (DESIGN §14). */
  topics: z.array(z.string().min(1)).min(1),
  catchup: z
    .object({
      on_start: z.boolean().default(true),
      limit: z.number().int().positive().default(100),
    })
    .default({}),
  live_push: z
    .object({
      enabled: z.boolean().default(false),
      mention_filter: z.boolean().default(false),
    })
    .default({}),
  permissions: z
    .object({
      // DANGEROUS; sandbox-only; default OFF (DESIGN §2.5/§14). Read but unused in v0.1.
      skip_permissions: z.boolean().default(false),
    })
    .default({}),
  /** Opaque to core; handed to the plugin verbatim (DESIGN §11). */
  backend_config: z.record(z.unknown()).default({}),
});

export type ParleyConfig = z.infer<typeof ConfigSchema>;

/** Validate + default a raw config object (already parsed from YAML/JSON). */
export function parseConfig(raw: unknown): ParleyConfig {
  return ConfigSchema.parse(raw);
}

/** Load + validate a YAML config file. */
export function loadConfig(path: string): ParleyConfig {
  const data: unknown = parseYaml(readFileSync(path, 'utf8'));
  return parseConfig(data);
}

/** The instance id used to namespace per-instance read-state (defaults to the handle). */
export function instanceIdOf(cfg: ParleyConfig): string {
  return cfg.instance_id ?? cfg.identity.handle;
}
