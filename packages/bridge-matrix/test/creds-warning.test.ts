import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin } from '../src/index.js';

// SEC-06 — Matrix must not silently log in with the repo-public default password. connect() does
// live I/O (the m.login.password POST), so we stub fetch with a valid login response; the warning
// fires before that POST. We still assert the whole connect() resolves so the gate sits on the
// happy path, not an incidental network failure.
const okLogin = (): Response =>
  new Response(JSON.stringify({ access_token: 't', user_id: '@parley:parley.local' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('Matrix default-credential warning (SEC-06)', () => {
  it('warns once, naming the backend and the key to set, when password is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okLogin()));
    const warn = spyWarn();
    await new MatrixPlugin().connect({ homeserver_url: 'http://127.0.0.1:8008', user: 'parley' });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('parley-matrix');
    expect(msg).toContain('password');
  });

  it('warns when password is set literally to the well-known default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okLogin()));
    const warn = spyWarn();
    await new MatrixPlugin().connect({ password: 'parleypass' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when a real password is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okLogin()));
    const warn = spyWarn();
    await new MatrixPlugin().connect({ password: 's3cret-real-pw', user: 'parley' });
    expect(warn).not.toHaveBeenCalled();
  });
});
