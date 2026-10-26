/**
 * The optional real-server pass is opt-in, and opting in must be honoured or reported — never
 * silently skipped. A skip on an unreachable server reports green having verified nothing against
 * a real Zulip, which is exactly the run an operator set those variables to get.
 */
import { describe, expect, it } from 'vitest';
import { decideIntegrationGate, REAL_SERVER_VARS } from './harness.js';

const URL_VAR = 'https://zulip.example.com';
const ALL = {
  PARLEY_ZULIP_URL: URL_VAR,
  PARLEY_ZULIP_EMAIL: 'bot@example.com',
  PARLEY_ZULIP_API_KEY: 'k',
};

const CASES = [
  {
    name: 'no variables set',
    vars: {},
    probe: undefined,
    kind: 'skip',
    mentions: REAL_SERVER_VARS[0],
  },
  {
    name: 'only the URL set',
    vars: { PARLEY_ZULIP_URL: URL_VAR },
    probe: undefined,
    kind: 'fail',
    mentions: 'PARLEY_ZULIP_EMAIL',
  },
  {
    name: 'a variable set to the empty string',
    vars: { ...ALL, PARLEY_ZULIP_API_KEY: '' },
    probe: undefined,
    kind: 'fail',
    mentions: 'PARLEY_ZULIP_API_KEY',
  },
  {
    name: 'all set and the server answers',
    vars: ALL,
    probe: { ok: true, detail: '200 OK' },
    kind: 'run',
    mentions: undefined,
  },
  {
    name: 'all set and the server is unreachable',
    vars: ALL,
    probe: { ok: false, detail: 'fetch failed' },
    kind: 'fail',
    mentions: URL_VAR,
  },
  {
    name: 'all set and the credentials are rejected',
    vars: ALL,
    probe: { ok: false, detail: '401 Unauthorized' },
    kind: 'fail',
    mentions: '401',
  },
  {
    name: 'all set but never probed',
    vars: ALL,
    probe: undefined,
    kind: 'fail',
    mentions: 'not probed',
  },
] as const;

describe('zulip optional real-server gate separates intent from availability', () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.kind}`, () => {
      const decision = decideIntegrationGate(c.vars, c.probe);
      expect(decision.kind).toBe(c.kind);
      if (c.mentions !== undefined && decision.kind !== 'run') {
        expect(decision.reason).toContain(c.mentions);
      }
    });
  }
});
