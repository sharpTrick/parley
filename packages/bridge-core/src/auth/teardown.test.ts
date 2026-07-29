import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig, type ParleyConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startFakeOidc, type FakeOidc } from '../testing/fake-oidc.js';
import { createRemoteAuthApp, type RemoteAuthServer } from './remote-auth.js';

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
let plugin: FakePlugin;

beforeAll(async () => {
  idp = await startFakeOidc();
  plugin = new FakePlugin();
  await plugin.connect({});
});
afterAll(async () => {
  await plugin.disconnect();
  await idp.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function baseCfg(): ParleyConfig {
  return parseConfig({ identity: { handle: 'agent' }, topics: ['ctx'] });
}

function oidcCfg(): ParleyConfig {
  return parseConfig({
    identity: { handle: 'agent' },
    topics: ['ctx'],
    auth: { mode: 'oidc', oidc: { issuer: idp.issuer, allowed_subjects: ['owner-sub'] } },
  });
}

/**
 * Every remote-app factory. A new one should add a row here: the class is "close() releases every
 * resource the factory acquired", and a background loop added behind any factory has to be caught
 * without anyone remembering to write a bespoke test for it.
 */
const FACTORIES: Array<[string, () => Promise<RemoteAuthServer>]> = [
  [
    'createRemoteAuthApp (builtin)',
    async () =>
      createRemoteAuthApp(plugin, baseCfg(), {
        publicUrl: new URL(`http://127.0.0.1:${await freePort()}`),
        verifyOwner: async () => true,
      }),
  ],
  [
    'createRemoteAuthApp (oidc)',
    async () =>
      createRemoteAuthApp(plugin, oidcCfg(), {
        publicUrl: new URL(`http://127.0.0.1:${await freePort()}`),
      }),
  ],
];

describe('close() releases every timer the factory acquired', () => {
  it.each(FACTORIES)('%s leaves no interval of its own running', async (_name, build) => {
    const created = new Set<unknown>();
    const cleared = new Set<unknown>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;

    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const handle = realSetInterval(...args);
      created.add(handle);
      return handle;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      handle: Parameters<typeof clearInterval>[0],
    ) => {
      cleared.add(handle);
      return realClearInterval(handle);
    }) as typeof clearInterval);

    const server = await build();
    const port = await freePort();
    await server.listen(port);
    expect(created.size).toBeGreaterThan(0); // the measurement itself must not be vacuous
    await server.close();

    const leaked = [...created].filter((h) => !cleared.has(h));
    expect(leaked).toEqual([]);
  });

  // A refed interval keeps node alive after close(), so a composition root that shut the bridge down
  // never exits. Asserting it over the recorder rather than per-loop means a newly added loop behind
  // any factory inherits the check.
  it.each(FACTORIES)('%s arms no interval that can hold the process open', async (_name, build) => {
    const created = new Set<{ hasRef?: () => boolean }>();
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const handle = realSetInterval(...args);
      created.add(handle);
      return handle;
    }) as typeof setInterval);

    const server = await build();
    try {
      await server.listen(await freePort());
      expect(created.size).toBeGreaterThan(0);
      expect([...created].filter((h) => h.hasRef?.() !== false)).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('close() drops the issued OAuth state', () => {
  it('an access token minted before close does not survive it', async () => {
    const server = (await FACTORIES[0]![1]()) as Extract<
      RemoteAuthServer,
      { provider: unknown }
    >;
    await server.listen(await freePort());
    const peek = server.provider as unknown as {
      issue(clientId: string, scopes: string[], resource: string): { access_token: string };
      access: Map<string, unknown>;
    };
    const { access_token } = peek.issue('c', ['mcp'], server.resource.href);
    await expect(server.provider.verifyAccessToken(access_token)).resolves.toBeTruthy();

    await server.close();

    expect(peek.access.size).toBe(0);
    await expect(server.provider.verifyAccessToken(access_token)).rejects.toThrow();
  });
});
