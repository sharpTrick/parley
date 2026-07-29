import { loadConfig } from '@sharptrick/parley-core';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROOM_PRESETS, type MatrixBackendConfig } from '../src/index.js';

/**
 * Two CLASSES over what this package ships for an operator to copy.
 *
 *  1. A shipped example config is executable, not illustrative. The multi-session page insists each
 *     session use a DIFFERENT Matrix account, and the default preset makes every provisioned room
 *     invite-only — so a set of configs that share a topic without inviting each other deploys to a
 *     system where only whichever session created the room works. That is checkable with no
 *     homeserver: it is a property of the three files.
 *  2. Every value a config union accepts is documented. A `room_preset` member absent from the
 *     README's config table is a privilege-granting option an operator meets only in the type.
 */

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const EXAMPLES = new URL('../../../examples/multi-session/matrix/', import.meta.url);

interface ShippedConfig {
  file: string;
  topics: string[];
  backend: MatrixBackendConfig;
}

// Loaded through core's own `loadConfig`, so a config that would not even parse in production — or
// that fails the schema — fails here rather than being read past by a bespoke parser.
const configs: ShippedConfig[] = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.yaml'))
  .map((file) => {
    const doc = loadConfig(fileURLToPath(new URL(file, EXAMPLES)));
    return {
      file,
      topics: doc.topics.map(String),
      backend: doc.backend_config as MatrixBackendConfig,
    };
  });

const mxidOf = (c: ShippedConfig): string => `@${c.backend.user}:${c.backend.server_name}`;

describe('the shipped multi-session configs deploy as documented', () => {
  it('finds the example configs it is meant to grade', () => {
    expect(configs.map((c) => c.file).length).toBeGreaterThan(2);
  });

  it.each(configs.map((c): [string, ShippedConfig] => [c.file, c]))(
    '%s: names an account and the fields that must agree',
    (_file, c) => {
      expect(c.backend.user).toBeTruthy();
      expect(c.backend.server_name).toBe(configs[0]!.backend.server_name);
      expect(c.backend.homeserver_url).toBe(configs[0]!.backend.homeserver_url);
      expect(c.backend.shared_room).toBeUndefined(); // production is one room per topic
    },
  );

  it('every account is distinct, as the README requires', () => {
    const users = configs.map((c) => c.backend.user);
    expect(new Set(users).size).toBe(users.length);
  });

  /**
   * Any of them may be the first to post to a shared topic, and the creator's `invite` is the only
   * thing that admits the rest — so the requirement is symmetric, not "somebody invites everybody".
   */
  it.each(
    configs.flatMap((creator) =>
      configs
        .filter((peer) => peer !== creator && peer.topics.some((t) => creator.topics.includes(t)))
        .map((peer): [string, ShippedConfig, ShippedConfig] => [
          `${creator.file} shares a topic with ${peer.file}`,
          creator,
          peer,
        ]),
    ),
  )('%s, so it invites it', (_name, creator, peer) => {
    expect(creator.backend.invite ?? []).toContain(mxidOf(peer));
  });
});

describe('every room_preset the config accepts is in the README config table', () => {
  const table = README.split('\n').filter((l) => l.startsWith('|'));

  it.each(ROOM_PRESETS)('%s', (preset) => {
    expect(table.join('\n')).toContain(`\`${preset}\``);
  });

  it('names the preset it deliberately refuses, so the omission reads as a decision', () => {
    expect(README).toContain('trusted_private_chat');
    expect(ROOM_PRESETS as readonly string[]).not.toContain('trusted_private_chat');
  });
});
