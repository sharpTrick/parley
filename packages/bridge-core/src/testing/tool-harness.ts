import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Allowlist } from '../allowlist.js';
import { parseConfig } from '../config.js';
import { DEFAULT_PRESENCE_TOPIC } from '../engine/presence.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import { registerTools, toolDepsFor, type ToolDeps } from '../transport/tools.js';
import { FakePlugin } from './fake-plugin.js';

/**
 * The ONE `McpServer + registerTools + linked-pair Client` fixture the tool tests run on.
 *
 * Three files used to spell out their own `ToolDeps` literal, and they had already drifted: two
 * passed a `SeenSet` and one omitted it, so the `fetch_recent` dedup warm-up went ungraded from a
 * file that looked like it covered it — an OPTIONAL dependency can vanish from a hand-typed literal
 * without anything turning red. So the defaults live here, per-file variation is an explicit
 * override, and {@link toolClient} refuses to build deps that silently lost a key.
 */
export interface ToolHarnessOptions extends Partial<ToolDeps> {
  /** Explicit `topics` for the default Allowlist. Ignored when `allow` is overridden. */
  topics?: string[];
  /** `post_topics` sources for the default Allowlist. Ignored when `allow` is overridden. */
  postPatterns?: string[];
}

export interface ToolHarness {
  plugin: FakePlugin;
  client: Client;
  deps: ToolDeps;
}

/**
 * The dependency keys a running bridge actually supplies, read off the production factory rather
 * than restated — so a new required {@link ToolDeps} field, which must be set there, is missing here
 * until this harness is taught about it.
 */
function productionDepKeys(): string[] {
  const cfg = parseConfig({ identity: { handle: 'probe' }, topics: ['ctx'] });
  return Object.keys(toolDepsFor(new FakePlugin(), cfg, { seen: new SeenSet() }));
}

export async function toolClient(opts: ToolHarnessOptions = {}): Promise<ToolHarness> {
  const plugin = (opts.plugin as FakePlugin | undefined) ?? new FakePlugin();
  await plugin.connect({});

  const deps: ToolDeps = {
    plugin,
    identity: asHandle('alice'),
    allow:
      opts.allow ??
      new Allowlist(opts.topics ?? ['ctx', 'ctx-reviews'], {
        postPatterns: opts.postPatterns,
        reserved: [DEFAULT_PRESENCE_TOPIC],
      }),
    seen: new SeenSet(),
    presenceTopic: asTopic(DEFAULT_PRESENCE_TOPIC),
    presenceTtlMs: 90_000,
    blockMaxMs: 60_000,
    blockPollIntervalMs: 20,
    now: undefined,
    ...Object.fromEntries(
      Object.entries(opts).filter(([k]) => k !== 'topics' && k !== 'postPatterns'),
    ),
  };

  const missing = productionDepKeys().filter(
    (k) => !(k in deps) || (deps[k as keyof ToolDeps] === undefined && !(k in opts)),
  );
  if (missing.length > 0)
    throw new Error(
      `tool harness is missing dependencies a real bridge supplies: ${missing.join(', ')}. ` +
        'Give each one a default here, or have the caller opt out by passing it explicitly as ' +
        'undefined.',
    );

  const server = new McpServer({ name: 'parley', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerTools(server, deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { plugin, client, deps };
}
