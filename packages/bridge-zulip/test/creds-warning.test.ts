import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';

// SEC-06 — Zulip must not silently run with the repo-public default API key. connect() does no
// network I/O (auth is per-request HTTP Basic), so the warning is emitted synchronously.
afterEach(() => {
  vi.restoreAllMocks();
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('Zulip default-credential warning (SEC-06)', () => {
  it('warns once, naming the backend and the key to set, when api_key is omitted', async () => {
    const warn = spyWarn();
    await new ZulipPlugin().connect({ site_url: 'http://127.0.0.1:9991' });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('parley-zulip');
    expect(msg).toContain('api_key');
  });

  it('warns when api_key is set literally to the well-known default', async () => {
    const warn = spyWarn();
    await new ZulipPlugin().connect({ api_key: 'parley-api-key', email: 'bot@example.com' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when a real api_key is supplied', async () => {
    const warn = spyWarn();
    await new ZulipPlugin().connect({ api_key: 's3cret-real-key', email: 'bot@example.com' });
    expect(warn).not.toHaveBeenCalled();
  });
});
