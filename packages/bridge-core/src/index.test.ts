// Barrel-surface regression guard.
//
// The public entry `@sharptrick/parley-core` is automated-semver surface: every symbol it
// re-exports is frozen by the release automation. This test pins the trimmed set (consumer-free
// internals that must NOT be public) and the kept seam/config/composition-root surface, so a
// future edit that re-adds an internal to the barrel fails loudly here.
//
// It is a test only — it does not re-export anything from the barrel.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('public barrel surface', () => {
  // The consumer-free internals kept out of the barrel. These stay defined in their own
  // modules (engine/presence.ts, identity-filter.ts, transport/tools.ts) for in-package callers,
  // reached via relative imports — but must never be reachable through the public entry.
  const trimmed = [
    'buildToolDefs',
    'matchGlob',
    'filterHandles',
    'MAX_RECORD_TOPICS',
    'MAX_INSTANCE_ID_LEN',
    'encodePresence',
    'decodePresence',
    'computeRoster',
  ] as const;

  // A representative slice of the deliberate kept surface (seam, config, engine, presence
  // default/types, composition roots).
  const kept = [
    'registerTools',
    'DEFAULT_PRESENCE_TOPIC',
    'asTopic',
    'asHandle',
    'asBackendMsgId',
    'asCursor',
    'safeName',
    'MIN_HASH_LEN',
    'MAX_HASH_LEN',
    'MAX_BLOCK_MS',
    'NoSuchTopicError',
    'isNoSuchTopicError',
    'parseMentions',
    'buildMessage',
    'createStdioBridge',
    'buildBridge',
    'loadConfig',
    'parseConfig',
    'Allowlist',
    'SeenSet',
    'catchUpTopic',
    'catchUpAll',
  ] as const;

  it.each(trimmed)('does not re-export the trimmed internal %s', (name) => {
    expect(name in api).toBe(false);
    expect((api as Record<string, unknown>)[name]).toBeUndefined();
  });

  it.each(kept)('still re-exports the kept symbol %s', (name) => {
    expect(name in api).toBe(true);
    expect((api as Record<string, unknown>)[name]).toBeDefined();
  });
});

// A doc comment on a barrel-exported symbol ships verbatim in `dist/*.d.ts` and is the only
// specification an out-of-tree plugin author reads. When it says "outside {@link MIN_HASH_LEN}…{@link
// MAX_HASH_LEN}" and only the floor is exported, that author can name the floor and must hardcode
// the ceiling — the doc promises a surface the package does not have. Pinning the one symbol by name
// would guard the instance; derive the offenders instead, so the next helper documented against an
// unexported constant is caught by the same case.
describe('shipped JSDoc never links a value the barrel withholds', () => {
  const SRC = fileURLToPath(new URL('./', import.meta.url));

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (extname(full) === '.ts' && !full.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  const EXPORT_DECL =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|function|async function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
  const VALUE_DECL = /^export\s+(?:const|function|async function|class)\s+([A-Za-z_$][\w$]*)/;

  // Type-only re-exports are part of the shipped surface but carry no runtime binding, so read the
  // barrel's own export clauses rather than only `Object.keys(api)`.
  const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const exposed = new Set<string>(Object.keys(api));
  for (const clause of barrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const spec of clause[1]!.split(',')) {
      const name = spec.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) exposed.add(name);
    }

  const files = sources(SRC);
  const values = new Set<string>();
  const documented: { file: string; owner: string; doc: string }[] = [];

  for (const file of files) {
    let block: string[] | null = null;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('/**')) block = [line];
      else if (block && (line.startsWith('*') || line.startsWith('*/'))) block.push(line);
      else {
        const owner = EXPORT_DECL.exec(line)?.[1];
        if (owner) {
          if (VALUE_DECL.test(line)) values.add(owner);
          if (block) documented.push({ file: file.slice(SRC.length), owner, doc: block.join('\n') });
        }
        block = null;
      }
    }
  }

  it('finds documented exports and exported values to check (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(documented.length).toBeGreaterThan(20);
    expect(values.size).toBeGreaterThan(20);
    expect(values.has('safeName')).toBe(true);
  });

  it('resolves every {@link} in a public doc comment to a public symbol', () => {
    const offenders: string[] = [];
    for (const { file, owner, doc } of documented) {
      if (!exposed.has(owner)) continue;
      for (const link of doc.matchAll(/\{@link\s+([A-Za-z_$][\w$]*)/g))
        if (values.has(link[1]!) && !exposed.has(link[1]!))
          offenders.push(`${file}: ${owner}'s doc links ${link[1]}, which index.ts does not export`);
    }
    expect(
      offenders,
      'export the linked symbol, or state it in prose — a consumer cannot follow a link to a symbol they cannot import',
    ).toEqual([]);
  });
});
