import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRemoteServer, type RemoteServerHandle } from '../server.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

let handle: RemoteServerHandle;
let origin: string;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-remote-ex-'));
  const cfgPath = join(dir, 'parley.config.yaml');
  writeFileSync(
    cfgPath,
    [
      'backend: local-sqlite',
      'identity: { handle: "owner" }',
      'topics: ["ctx-handoff"]',
      'catchup: { on_start: false }',
      'live_push: { enabled: false }',
      `backend_config: { db_path: "${join(dir, 'p.db')}" }`,
    ].join('\n'),
  );
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  handle = await startRemoteServer({
    configPath: cfgPath,
    issuerUrl: new URL(origin),
    port,
    ownerPassphrase: 'test-pass',
  });
});

afterEach(async () => {
  await handle.close();
});

describe('self-host-remote reference server', () => {
  it('boots and serves Protected Resource Metadata at the /mcp-suffixed path', async () => {
    const prm = (await (
      await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${origin}/mcp`);
    expect(Array.isArray(prm.authorization_servers)).toBe(true);
  });

  it('rejects unauthenticated /mcp with 401', async () => {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});
