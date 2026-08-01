import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as allowlistMod from '../allowlist.js';
import {
  INITIALIZE,
  MCP_HEADERS,
  NO_PRESENCE,
  serveRemoteHttp,
  type ServedApp,
} from '../testing/http-app.js';
import { parse } from '../testing/tool-cases.js';

/**
 * One subject: what a client gets back from the reactive /mcp endpoint, and what each POST costs.
 * The endpoint is STATELESS — a fresh transport + server per request — so the round trip, the
 * per-request rebuild, and the absence of any session id are three readings of the same design.
 * Its refusals live in http-gating.test.ts and its start/stop in root-lifecycle.test.ts.
 */

let served: ServedApp;
let client: Client;

async function connectTo(port: number): Promise<Client> {
  const c = new Client({ name: 'chat-stand-in', version: '0.0.0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return c;
}

beforeEach(async () => {
  served = await serveRemoteHttp({ insecureNoAuth: true });
  client = await connectTo(served.port);
});

afterEach(async () => {
  await client.close();
  await served.teardown();
});

describe('remote HTTP transport (reactive, unauthenticated)', () => {
  it('connects over HTTP and lists the reactive tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'parley_fetch_recent',
      'parley_list_users',
      'parley_post',
      'parley_reply',
    ]);
  });

  it('post + fetch_recent round-trip over HTTP', async () => {
    await client.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'hello over http' } });
    const res = await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: 'ctx' } });
    const out = parse(res) as { messages: Array<{ content: string }> };
    expect(out.messages.map((m) => m.content)).toEqual(['hello over http']);
  });

  it('is reactive-only — does NOT advertise the claude/channel capability', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.['claude/channel']).toBeUndefined();
    expect(caps?.tools).toBeDefined();
  });

  it('rejects a topic outside the allowlist (isError, not a crash)', async () => {
    const res = (await client.callTool({
      name: 'parley_post',
      arguments: { topic: 'secret', content: 'x' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    // Closed allowlist → `topic` is a z.enum, so the SDK rejects a disallowed topic at the schema
    // layer (Invalid enum value); with a post pattern it would be allow.assert's "topic not
    // allowed". Either way it is an isError result, not a crash.
    expect(res.content[0]!.text).toMatch(/invalid enum value|topic not allowed/i);
  });
});

/**
 * What app scope actually amortizes, MEASURED on both sides. A stateless transport splits its work
 * in two — derived once when the app is built, and rebuilt for every POST — and a claim about which
 * side a given piece falls on is worth exactly what the count that pins it is worth: an operator
 * profiling a slow /mcp endpoint under a large `topics` + `post_topics` config is steered by it.
 * So take a reading on each side: a total for what is shared, and a per-request DELTA for what is
 * not, so that a piece silently moving between them fails here instead of being described wrongly.
 */
describe('reactive HTTP: what app scope amortizes, and what it does not', () => {
  it('compiles the allowlist once for the app, and rebuilds the tool descriptions per POST', async () => {
    const spy = vi.spyOn(allowlistMod, 'allowlistFor');
    const readers = new Set<unknown>();
    const realTopics = allowlistMod.Allowlist.prototype.topics;
    // `allow.topics()` is what `describeAllowed`/`topicList`/`topicSchema` walk to build each tool's
    // description and enum, so its call count is the tool-description build count.
    const described = vi
      .spyOn(allowlistMod.Allowlist.prototype, 'topics')
      .mockImplementation(function (this: allowlistMod.Allowlist): ReturnType<typeof realTopics> {
        readers.add(this);
        return realTopics.call(this);
      });
    // Presence off: keep this focused on the request path (a presence loop reuses deps.allow anyway).
    const { port, teardown } = await serveRemoteHttp({ insecureNoAuth: true }, NO_PRESENCE);
    const c = await connectTo(port);
    try {
      // Several POSTs, each building a brand-new reactive server + transport. `parley_post`'s
      // handler never reads the topic list itself, so every call counted is a description rebuild.
      described.mockClear();
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'a' } });
      const perPost = described.mock.calls.length;
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'b' } });
      await c.callTool({ name: 'parley_post', arguments: { topic: 'ctx', content: 'c' } });

      // The descriptions are NOT amortized: they cost the same again on every POST.
      expect(perPost).toBeGreaterThan(0);
      expect(described.mock.calls.length).toBe(3 * perPost);
      // The allowlist (and its regex compilation) IS: built exactly once, at app scope …
      expect(spy).toHaveBeenCalledTimes(1);
      expect(readers.size).toBe(1); // … and every request read that same instance.
    } finally {
      await c.close();
      await teardown();
      described.mockRestore();
      spy.mockRestore();
    }
  });
});

/**
 * The public JSDoc once described the opposite design (session-per-connection, reused by
 * `mcp-session-id`). Pin the observable session contract instead of the sentence, so a doc that
 * regrows session affinity is contradicted by a failing test rather than by a neighbouring comment.
 */
describe('reactive HTTP is stateless: no session id, no GET/DELETE', () => {
  it('the initialize response carries no mcp-session-id header', async () => {
    const { port, teardown } = await serveRemoteHttp({ insecureNoAuth: true }, NO_PRESENCE);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: INITIALIZE,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
    } finally {
      await teardown();
    }
  });

  // Keep GET/DELETE's 405 in the METHOD × auth grid in http-gating.test.ts rather than here, so that
  // a case asserting it cannot pass on a route that has silently lost its auth middleware.
});
