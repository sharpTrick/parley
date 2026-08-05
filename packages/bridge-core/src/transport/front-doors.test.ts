import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardenErrorSurface } from '../auth/error-surface.js';
import {
  FRONT_DOORS,
  exportedDoorFactories,
  internalsLeaked,
  triggerNamed,
} from '../testing/front-doors.js';

/**
 * The audit's SUBJECTS, graded. An app-wide security control is applied per factory, so a factory
 * nobody added to the audit is a control nobody checks — which is how the reactive door shipped
 * without one while a matrix of its two siblings stayed green and claimed to cover every door.
 *
 * So the registry is derived twice over, from two places a new factory cannot avoid: the module's
 * export NAMES, walked here, and its export TYPES, which the registry is `satisfies
 * Record<DoorName, …>` against — a merge gate, since CI compiles the tsconfig.test project. The
 * rows below are what make the name half fail loudly instead of walking a shorter list in silence.
 */
describe('the front-door audit derives its own subjects', () => {
  it('grades every app factory the package exports, and only those', () => {
    const audited = FRONT_DOORS.map((d) => d.name).sort();
    expect(audited).toEqual(exportedDoorFactories());
    expect(audited.length, 'the derivation found no doors to grade').toBeGreaterThanOrEqual(3);
  });

  it('every audited door names a route to grade and a failure that reaches the handler', () => {
    for (const door of FRONT_DOORS) {
      expect(door.routes.length, door.name).toBeGreaterThan(0);
      expect(door.routes, door.name).toContain(door.terminal.route);
      expect(() => triggerNamed(door.terminal.trigger), door.name).not.toThrow();
    }
  });
});

/**
 * The leak detector, graded on a door that really is unhardened — otherwise a detector that had
 * stopped detecting anything would report every door clean and read exactly like a hardened
 * package. The pair is the point: the same request, the same probe, one app with the control and
 * one without.
 */
describe('an unhardened door fails the audit (negative control)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function probe(harden: boolean): Promise<string> {
    const before = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const app = express();
    app.post('/mcp', express.json(), (_req, res) => {
      res.status(204).end();
    });
    if (harden) hardenErrorSurface(app);
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const t = triggerNamed('unparseable body for the declared type');
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, {
        method: 'POST',
        headers: t.headers,
        body: t.body,
      });
      return await res.text();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('reports the leak an app without the control publishes', async () => {
    expect(internalsLeaked(await probe(false))).not.toEqual([]);
  });

  it('reports nothing once the same app applies it', async () => {
    expect(internalsLeaked(await probe(true))).toEqual([]);
  });
});
