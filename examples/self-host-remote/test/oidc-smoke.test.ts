import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Vitest runs against package sources, so the internal test helper is importable here.
import { startFakeOidc, type FakeOidc } from '../../../packages/bridge-core/src/testing/fake-oidc.js';
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

let idp: FakeOidc;
let handle: RemoteServerHandle;
let origin: string;

beforeEach(async () => {
  idp = await startFakeOidc();
  const dir = mkdtempSync(join(tmpdir(), 'parley-remote-oidc-ex-'));
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
      'auth:',
      '  mode: oidc',
      '  oidc:',
      `    issuer: "${idp.issuer}"`,
      '    required_role: "parley-owner"',
    ].join('\n'),
  );
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  // NOTE: no ownerPassphrase — the IdP owns login in oidc mode.
  handle = await startRemoteServer({
    configPath: cfgPath,
    issuerUrl: new URL(origin),
    port,
  });
});

afterEach(async () => {
  await handle.close();
  await idp.close();
});

describe('self-host-remote reference server (oidc auth mode)', () => {
  it('boots without an owner secret and points PRM at the external issuer', async () => {
    const prm = (await (
      await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${origin}/mcp`);
    expect(prm.authorization_servers).toEqual([idp.issuer]);
  });

  it('accepts an IdP token with the required role for tools/list, rejects one without', async () => {
    const call = (token: string) =>
      fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const good = await call(
      await idp.mint({ aud: `${origin}/mcp`, realm_access: { roles: ['parley-owner'] } }),
    );
    expect(good.status).toBe(200);
    const noRole = await call(await idp.mint({ aud: `${origin}/mcp` }));
    expect(noRole.status).toBe(401);
  });
});
