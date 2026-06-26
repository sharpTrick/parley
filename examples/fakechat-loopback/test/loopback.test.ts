import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  asHandle,
  asTopic,
  buildBridge,
  CHANNEL_NOTIFICATION_METHOD,
  parseConfig,
  type ParleyBridge,
} from '@parley/core';
import { SqlitePlugin } from '@parley/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Headless substitute for the live `claude --channels` fakechat loop (which needs an
 * interactive Claude Code session — see MANUAL-CHECKLIST.md). An in-process MCP Client over
 * InMemoryTransport stands in for Claude Code: it asserts the server advertises the channel
 * capability, receives notifications/claude/channel events when another participant posts, and
 * can reply durably.
 */

interface ChannelNote {
  method: string;
  params: { content: string; meta: Record<string, string> };
}

const TOPIC = 'ctx-demo';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'parley-loop-'));
}

let bridge: ParleyBridge;
let client: Client;
let writer: SqlitePlugin;
let notes: ChannelNote[];

beforeEach(async () => {
  const dir = tmpDir();
  const dbPath = join(dir, 'p.db');
  const cfg = parseConfig({
    identity: { handle: 'agent' },
    topics: [TOPIC],
    state_path: join(dir, 'read-state.json'),
    live_push: { enabled: true },
    catchup: { on_start: true },
    backend_config: { db_path: dbPath, poll_interval_ms: 50 },
  });

  bridge = await buildBridge(new SqlitePlugin(), cfg);

  notes = [];
  client = new Client({ name: 'fakechat-stand-in', version: '0.0.0' }, { capabilities: {} });
  client.fallbackNotificationHandler = (n) => {
    notes.push(n as unknown as ChannelNote);
    return Promise.resolve();
  };

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await bridge.attach(serverT);
  await client.connect(clientT);

  // A second participant on the same DB (e.g. a human in another client, or another session).
  writer = new SqlitePlugin();
  await writer.connect({ db_path: dbPath, poll_interval_ms: 50 });
});

afterEach(async () => {
  await client.close();
  await writer.disconnect();
  await bridge.shutdown();
});

describe('fakechat loopback (headless)', () => {
  it('advertises the claude/channel capability, tools, and instructions', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.['claude/channel']).toBeDefined();
    expect(caps?.tools).toBeDefined();
    expect(client.getInstructions() ?? '').toMatch(/Parley channel/);
  });

  it('lists the reactive + reply tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'parley_fetch_recent',
      'parley_post',
      'parley_reply',
    ]);
  });

  it('pushes a <channel> event when another participant posts', async () => {
    await writer.post(asTopic(TOPIC), asHandle('bob'), 'build is green @agent');
    await vi.waitFor(() => expect(notes.length).toBeGreaterThan(0), { timeout: 3000, interval: 20 });

    const note = notes.find((n) => n.method === CHANNEL_NOTIFICATION_METHOD);
    expect(note).toBeDefined();
    expect(note!.params.content).toBe('build is green @agent');
    expect(note!.params.meta.topic).toBe(TOPIC);
    expect(note!.params.meta.sender).toBe('bob');
    expect(note!.params.meta.mentions).toBe('agent');
    expect(note!.params.meta.msg_id).toBeDefined();
    expect(note!.params.meta.cursor).toBeDefined();
    // Every meta key is an identifier (the silently-dropped-hyphen guard).
    for (const key of Object.keys(note!.params.meta)) {
      expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it('parley_reply writes durably (survives for the next catch-up)', async () => {
    const res = (await client.callTool({
      name: 'parley_reply',
      arguments: { topic: TOPIC, content: 'on it' },
    })) as { content: Array<{ text: string }> };
    const { backendMsgId } = JSON.parse(res.content[0]!.text) as { backendMsgId: string };
    expect(backendMsgId).toBeTruthy();

    const recent = await writer.fetchRecent({ topic: asTopic(TOPIC) });
    expect(recent.messages.some((m) => m.content === 'on it')).toBe(true);
  });

  it('does not re-push a message already pulled via the fetch_recent tool (dedup)', async () => {
    // Post, then immediately pull it via the tool (marks it seen) before the poll loop reaches it.
    await writer.post(asTopic(TOPIC), asHandle('bob'), 'pull-me-first');
    await client.callTool({ name: 'parley_fetch_recent', arguments: { topic: TOPIC } });

    // Give the poll loop several intervals to (not) emit it.
    await new Promise((r) => setTimeout(r, 250));
    const pushed = notes.filter(
      (n) => n.method === CHANNEL_NOTIFICATION_METHOD && n.params.content === 'pull-me-first',
    );
    expect(pushed).toHaveLength(0);
  });
});
