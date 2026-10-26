import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: diagnostics discarded on the failure path. A bridge whose stream is flapping, whose
// credentials were revoked, or that was banned from a room must leave a trace an operator can act
// on — and it must go to STDERR, because cli.ts owns stdout as a JSON-RPC channel. Silent handlers
// (`on('error', () => undefined)`) and a swallowed re-join rejection are how a permanently broken
// bridge looks exactly like an idle one.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const CONFIG = { username: 'parley', password: 's3cret-real-pw' };

describe('XMPP failure-path diagnostics', () => {
  afterEach(() => {
    mockState.client = undefined;
    vi.restoreAllMocks();
  });

  it('reports a stream error on stderr (never stdout), rate-limited', async () => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const plugin = new XmppPlugin();
    await plugin.connect(CONFIG);
    fake.emit('error', new Error('stream boom'));
    fake.emit('error', new Error('stream boom again'));

    expect(errors).toHaveBeenCalledTimes(1); // the burst is collapsed, not multiplied
    expect(String(errors.mock.calls[0]?.[0])).toContain('stream boom');
    expect(stdout).not.toHaveBeenCalled();
    await plugin.disconnect();
  });

});

// Class: a join re-driven for ANY reason must report its failure, and the seam call that caused it
// must not report success over a topic it has left dead. Every trigger below drops the plugin's
// cached join and drives a fresh one; a rejection swallowed on any of them leaves a SUBSCRIBED topic
// outside its MUC with live push dead for good and nothing on stderr — indistinguishable from an
// idle bridge. The suite pinned only the reconnect trigger, so the nick-adoption path shipped
// discarding every rejection through `Promise.allSettled` and was graded by nothing.
//
// Each row asserts the line — the room, the server's own condition, and the consequence it promises
// the operator — AND the push state that line describes: dead while the re-join keeps bouncing, and
// alive again once a later seam call re-enters the room. A row therefore cannot pass on the log
// alone, and the promise the line makes is graded rather than merely printed.

interface Redrive {
  name: string;
  /** What the report must name the re-drive as. */
  after: string;
  /** Drive it, leaving the SUBSCRIBED room's re-join bounced. Never throws for the caller. */
  drive(ctx: RedriveCtx): Promise<void>;
  /** Pin `backend_config.nick`, so that only the row that MEANS to adopt one drives a nick change. */
  pinNick?: false;
}
interface RedriveCtx {
  plugin: XmppPlugin;
  fake: FakeXmpp;
  topic: Topic;
  room: string;
  /** A second topic, so a trigger can be driven through a call that is NOT about `topic`. */
  otherTopic: Topic;
}

/** Longer than the ladder's first step (200 ms + up to 200 ms of jitter). */
const LADDER_MS = 900;
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const redrives: Redrive[] = [
  {
    name: 'a reconnect',
    after: 'reconnect',
    drive: async ({ fake }) => {
      fake.emit('online'); // the initial connect, consumed by the first-online guard
      fake.emit('online'); // the reconnect: occupancy is gone and every room is re-driven
      await settle(50);
    },
  },
  {
    name: 'a kick (the re-entry ladder)',
    after: 'losing occupancy',
    drive: async ({ fake, room }) => {
      fake.endOccupancy(room, { statuses: ['307'] });
      await settle(LADDER_MS);
    },
  },
  {
    name: 'a post bounced as not-an-occupant',
    after: 'losing occupancy',
    drive: async ({ plugin, fake, topic }) => {
      fake.postReply = 'error';
      fake.postErrorCondition = 'not-acceptable';
      await plugin.post(topic, asHandle('parley'), 'x').catch(() => undefined);
      await settle(LADDER_MS);
    },
  },
  {
    name: 'nick adoption on the first post to ANOTHER topic',
    after: 'a nick change',
    pinNick: false,
    drive: async ({ plugin, otherTopic }) => {
      await plugin.post(otherTopic, asHandle('alice'), 'hello').catch(() => undefined);
      await settle(50);
    },
  },
];

describe('XMPP reports every re-driven join that fails', () => {
  afterEach(() => {
    mockState.client = undefined;
    vi.restoreAllMocks();
  });

  it.each(redrives)('$name', async ({ after, drive, pinNick }) => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const plugin = new XmppPlugin();
    await plugin.connect(pinNick === false ? CONFIG : { ...CONFIG, nick: 'parley-pinned' });
    const topic = asTopic('t-redrive');
    const otherTopic = asTopic('t-redrive-other');
    const room = priv(plugin).roomJid(topic);
    const seen: string[] = [];
    await plugin.subscribe(topic, (m) => seen.push(m.content));

    fake.joinReply = 'error';
    fake.joinErrorCondition = 'forbidden';
    await drive({ plugin, fake, topic, room, otherTopic });

    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(`re-join after ${after} failed for ${room}`);
    expect(logged).toContain('forbidden'); // the condition, not a flattened 'error'
    expect(logged).toContain('live push for this topic stays dead');

    // The consequence the line names, not just the line: the room is left, and it stays left.
    expect(priv(plugin).joined.has(room)).toBe(false);
    fake.deliver(room, 'while-out');
    await settle(20);
    expect(seen).toEqual([]);

    // And the recovery it names: the next seam call re-enters the room and push comes back.
    fake.joinReply = 'self';
    fake.postReply = 'reflect';
    await plugin.fetchRecent({ topic });
    fake.deliver(room, 'after-re-entry');
    await settle(20);
    expect(seen).toEqual(['after-re-entry']);

    await plugin.disconnect();
  }, 15_000);
});

// Class: a fallback that degrades a documented durability property without a signal. A room this
// plugin creates is configured PERSISTENT because a non-persistent MUC and its entire MAM archive
// are destroyed when the last occupant leaves — which every stream drop causes — so a service that
// refuses the field silently converts "history survives a reconnect" into "catch-up returns an empty
// page after the next blip". The join resolves either way, so nothing downstream can tell; the only
// place the operator can learn it is stderr. The table walks every way the config submit can fail,
// with the accepting service as the negative control so a green row is not a dead assertion.

interface DurabilityRow {
  name: string;
  ownerConfig: FakeXmpp['ownerConfig'];
  /** How many stderr lines the room earns: one per submit that failed. */
  lines: number;
  /** Phrases the operator needs: what was refused, and what it costs them. */
  reports: RegExp[];
  /**
   * What the report must name the refusal as, in full. The server attaches a `<text>` explaining
   * itself and `@xmpp/error` folds that into the error's MESSAGE, so a report built from the
   * message rather than from the defined condition reads `not-allowed - <prose>` here — which is
   * the difference between a line an operator can match on and one that carries a server's free
   * text into a diagnostic.
   */
  named: string;
}
const durabilityRows: DurabilityRow[] = [
  {
    name: 'the persistent-room submit is refused',
    ownerConfig: 'refuses-persistent',
    lines: 1,
    reports: [/NON-PERSISTENT/, /destroyed when the last occupant leaves/],
    named: '(not-allowed)',
  },
  {
    name: 'the bare instant-room fallback is refused too',
    ownerConfig: 'refuses-everything',
    lines: 2,
    reports: [/NON-PERSISTENT/, /stays LOCKED/],
    named: '(not-allowed)',
  },
  {
    name: 'the owner IQ is never answered',
    ownerConfig: 'times-out',
    lines: 2,
    reports: [/NON-PERSISTENT/, /stays LOCKED/],
    named: '(timeout)',
  },
  {
    name: 'the service accepts it (negative control)',
    ownerConfig: 'accepts',
    lines: 0,
    reports: [],
    named: '',
  },
];

describe('XMPP reports a room it could not make durable', () => {
  it.each(durabilityRows)('$name', async (row) => {
    const fake = new FakeXmpp();
    fake.announceCreation = true; // status 201: this join CREATED the room, so it configures it
    fake.ownerConfig = row.ownerConfig;
    mockState.client = fake;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => {
      errors.push(String(m));
    });

    const plugin = new XmppPlugin();
    await plugin.connect(CONFIG);
    const topic = asTopic(`t-durable-${row.ownerConfig}`);
    const room = priv(plugin).roomJid(topic);
    try {
      // The join still succeeds — the point is that it stops being SILENT, not that it starts failing.
      await expect(plugin.post(topic, asHandle('a'), 'hello')).resolves.toBeDefined();
      const durability = errors.filter((m) => m.includes(room));
      expect(durability).toHaveLength(row.lines);
      for (const phrase of row.reports) expect(durability.join('\n')).toMatch(phrase);
      if (row.named !== '') expect(durability.join('\n')).toContain(row.named);
    } finally {
      await plugin.disconnect();
    }
  });
});
