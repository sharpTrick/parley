import { asHandle, asTopic } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NatsPlugin } from '../src/index.js';

// Class: teardown interleaved with SETUP. `connect()` is several round trips long, and a
// `disconnect()` that lands inside it finds no handles to tear down — so a connect that then
// finishes normally publishes a live connection to a caller that already awaited teardown, and
// `maxReconnectAttempts: -1` means the socket it leaves behind never gives up. The invariant is the
// same at every await point and for every call that races the setup, so it is asserted as one
// property over a table of interleavings rather than at the one offset that happened to be found.
// The driver is stubbed with gates rather than timers, so each interleaving is exact.
vi.mock('nats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nats')>();
  return { ...actual, connect: vi.fn() };
});

interface Gate {
  held: Promise<void>;
  open: () => void;
}

const gate = (): Gate => {
  let open = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    open = () => {
      resolve();
    };
  });
  return { held, open };
};

/** Long enough for an in-flight `connect()` to reach the await under test. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const peek = (plugin: NatsPlugin): { nc?: { isClosed: () => boolean }; stopped: boolean } =>
  plugin as unknown as { nc?: { isClosed: () => boolean }; stopped: boolean };

/** A stubbed link whose two setup round trips can be held open independently. */
const stubLink = (): { closed: () => boolean; connectGate: Gate; jsmGate: Gate } => {
  const connectGate = gate();
  const jsmGate = gate();
  let closed = false;
  vi.mocked(connect).mockImplementation(async () => {
    await connectGate.held;
    return {
      jetstream: () => ({}),
      jetstreamManager: async () => {
        await jsmGate.held;
        return {};
      },
      drain: async () => undefined,
      close: async () => {
        closed = true;
      },
      isClosed: () => closed,
    } as never;
  });
  return { closed: () => closed, connectGate, jsmGate };
};

const awaitPoints = ['the driver connect', 'jetstreamManager'] as const;

describe('nats lifecycle — a disconnect() inside a connect() wins', () => {
  beforeEach(() => {
    vi.mocked(connect).mockReset();
  });

  for (const point of awaitPoints) {
    it(`disconnect() while ${point} is in flight: no live handle is published`, async () => {
      const link = stubLink();
      if (point !== 'the driver connect') link.connectGate.open();
      const plugin = new NatsPlugin();
      const connecting = plugin.connect({ servers: '127.0.0.1:4222' });
      await settle();

      await plugin.disconnect();

      // The invariant, the moment the caller's disconnect() resolves.
      expect(peek(plugin).stopped).toBe(true);
      expect(peek(plugin).nc?.isClosed() ?? true).toBe(true);

      link.connectGate.open();
      link.jsmGate.open();
      await expect(connecting).rejects.toThrow(/disconnect/);

      // …and it still holds once the cancelled connect has run to completion.
      expect(peek(plugin).stopped).toBe(true);
      expect(peek(plugin).nc).toBeUndefined();
      // The socket the cancelled connect DID open is closed, not stranded on its reconnect loop.
      expect(link.closed()).toBe(true);
    });

    it(`a read racing a connect() still in ${point} is refused, not served`, async () => {
      const link = stubLink();
      if (point !== 'the driver connect') link.connectGate.open();
      const plugin = new NatsPlugin();
      const connecting = plugin.connect({ servers: '127.0.0.1:4222' });
      await settle();

      const topic = asTopic('race');
      await expect(plugin.fetchRecent({ topic })).rejects.toThrow(/not connected/);
      await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow(/not connected/);
      await expect(plugin.post(topic, asHandle('sys'), 'x')).rejects.toThrow(/not connected/);

      link.connectGate.open();
      link.jsmGate.open();
      await connecting;
      await plugin.disconnect();
    });
  }

  it('a cancelled connect() leaves the plugin connectable again', async () => {
    const first = stubLink();
    const plugin = new NatsPlugin();
    const cancelled = plugin.connect({ servers: '127.0.0.1:4222' });
    await settle();
    await plugin.disconnect();
    first.connectGate.open();
    first.jsmGate.open();
    await expect(cancelled).rejects.toThrow(/disconnect/);

    const second = stubLink();
    second.connectGate.open();
    second.jsmGate.open();

    await plugin.connect({ servers: '127.0.0.1:4222' });

    expect(peek(plugin).stopped).toBe(false);
    expect(peek(plugin).nc).toBeDefined();
    await plugin.disconnect();
    expect(second.closed()).toBe(true);
  });

  // The control row: with nothing racing it, the same sequence must publish the handles and then
  // tear them down — so the rows above cannot be satisfied by a connect() that never works.
  it('an unraced connect() publishes its handles, and disconnect() closes them', async () => {
    const link = stubLink();
    link.connectGate.open();
    link.jsmGate.open();
    const plugin = new NatsPlugin();

    await plugin.connect({ servers: '127.0.0.1:4222' });
    expect(peek(plugin).stopped).toBe(false);
    expect(peek(plugin).nc).toBeDefined();

    await plugin.disconnect();
    expect(peek(plugin).stopped).toBe(true);
    expect(peek(plugin).nc).toBeUndefined();
    expect(link.closed()).toBe(true);
  });
});
