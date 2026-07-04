import { describe, expect, it } from 'vitest';
import { instanceIdOf, parseConfig } from './config.js';

describe('config loader', () => {
  it('applies defaults from a minimal config', () => {
    const cfg = parseConfig({ identity: { handle: 'ctx-payments' }, topics: ['ctx-payments'] });
    expect(cfg.backend).toBe('local-sqlite');
    expect(cfg.catchup).toEqual({ on_start: true, limit: 100 });
    expect(cfg.live_push).toEqual({ enabled: false, mention_filter: false });
    expect(cfg.permissions.skip_permissions).toBe(false);
    expect(cfg.backend_config).toEqual({});
    expect(cfg.post_topics).toEqual([]);
    // Presence defaults: single shared topic, 10-min heartbeat, TTL = 3× heartbeat.
    expect(cfg.presence).toEqual({
      enabled: true,
      topic: 'parley-presence',
      heartbeat_ms: 600_000,
      ttl_ms: 1_800_000,
    });
  });

  it('derives presence.ttl_ms from an explicit heartbeat, but honors an explicit ttl', () => {
    const derived = parseConfig({
      identity: { handle: 'h' },
      topics: ['a'],
      presence: { heartbeat_ms: 60_000 },
    });
    expect(derived.presence.ttl_ms).toBe(180_000);
    const pinned = parseConfig({
      identity: { handle: 'h' },
      topics: ['a'],
      presence: { heartbeat_ms: 60_000, ttl_ms: 500_000 },
    });
    expect(pinned.presence.ttl_ms).toBe(500_000);
  });

  it('accepts post_topics and rejects an uncompilable regex', () => {
    const cfg = parseConfig({ identity: { handle: 'h' }, topics: ['a'], post_topics: ['ctx-.*'] });
    expect(cfg.post_topics).toEqual(['ctx-.*']);
    expect(() =>
      parseConfig({ identity: { handle: 'h' }, topics: ['a'], post_topics: ['ctx-('] }),
    ).toThrow(/invalid regex/);
  });

  it('rejects an explicit topic that collides with the presence topic', () => {
    expect(() =>
      parseConfig({ identity: { handle: 'h' }, topics: ['parley-presence'] }),
    ).toThrow(/reserved for presence/);
    // Also when the presence topic is customized.
    expect(() =>
      parseConfig({
        identity: { handle: 'h' },
        topics: ['a', 'live'],
        presence: { topic: 'live' },
      }),
    ).toThrow(/reserved for presence/);
  });

  it('merges partial nested objects with per-field defaults', () => {
    const cfg = parseConfig({
      identity: { handle: 'a' },
      topics: ['a'],
      catchup: { limit: 50 },
      live_push: { enabled: true },
    });
    expect(cfg.catchup).toEqual({ on_start: true, limit: 50 });
    expect(cfg.live_push).toEqual({ enabled: true, mention_filter: false });
  });

  it('passes backend_config through opaquely', () => {
    const cfg = parseConfig({
      identity: { handle: 'a' },
      topics: ['a'],
      backend_config: { db_path: '/tmp/x.db', poll_interval_ms: 250 },
    });
    expect(cfg.backend_config).toEqual({ db_path: '/tmp/x.db', poll_interval_ms: 250 });
  });

  it('instanceIdOf defaults to the handle but honors instance_id', () => {
    expect(instanceIdOf(parseConfig({ identity: { handle: 'h' }, topics: ['a'] }))).toBe('h');
    expect(
      instanceIdOf(parseConfig({ identity: { handle: 'h' }, topics: ['a'], instance_id: 'sess-2' })),
    ).toBe('sess-2');
  });

  it('rejects a config with no topics', () => {
    expect(() => parseConfig({ identity: { handle: 'h' }, topics: [] })).toThrow();
  });

  it('rejects a config with no handle', () => {
    expect(() => parseConfig({ topics: ['a'] })).toThrow();
  });

  it('defaults auth to the built-in OAuth AS when absent', () => {
    const cfg = parseConfig({ identity: { handle: 'h' }, topics: ['a'] });
    expect(cfg.auth).toEqual({ mode: 'builtin' });
  });

  it('rejects auth.mode oidc without an oidc block', () => {
    expect(() =>
      parseConfig({ identity: { handle: 'h' }, topics: ['a'], auth: { mode: 'oidc' } }),
    ).toThrow(/auth\.oidc/);
  });

  it('parses a full oidc auth block with per-field defaults', () => {
    const cfg = parseConfig({
      identity: { handle: 'h' },
      topics: ['a'],
      auth: {
        mode: 'oidc',
        oidc: {
          issuer: 'https://kc.example.com/realms/parley',
          audience: 'parley-mcp',
          required_role: 'parley-owner',
          allowed_usernames: ['alice'],
        },
      },
    });
    expect(cfg.auth.mode).toBe('oidc');
    expect(cfg.auth.oidc).toEqual({
      issuer: 'https://kc.example.com/realms/parley',
      audience: 'parley-mcp',
      required_role: 'parley-owner',
      allowed_usernames: ['alice'],
      clock_skew_s: 30,
    });
  });

  it('rejects a bad issuer URL, empty gate lists, and out-of-range clock skew', () => {
    const base = { identity: { handle: 'h' }, topics: ['a'] };
    expect(() =>
      parseConfig({ ...base, auth: { mode: 'oidc', oidc: { issuer: 'not-a-url' } } }),
    ).toThrow();
    expect(() =>
      parseConfig({
        ...base,
        auth: { mode: 'oidc', oidc: { issuer: 'https://kc.example.com/realms/x', allowed_subjects: [] } },
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        ...base,
        auth: { mode: 'oidc', oidc: { issuer: 'https://kc.example.com/realms/x', clock_skew_s: 301 } },
      }),
    ).toThrow();
  });
});
