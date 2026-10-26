import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';

// Class: a lifecycle call that FAILS while leaving a live transport behind. `@xmpp/client` ships
// `@xmpp/reconnect`, which is listening for 'disconnect' from the moment the client is constructed,
// so a client whose `start()` rejected goes on redialling roughly once a second — re-presenting
// `backend_config.password` to a server the caller believes it never reached, holding the event
// loop open, and accumulating one loop per attempt behind a supervisor that retries connect().
// Nothing the plugin holds can stop it if the failure path never took ownership of the client.
//
// This suite deliberately does NOT mock '@xmpp/client': the reconnect behaviour IS the thing under
// test, and every fake in this package models a client that has none.

interface Failure {
  name: string;
  /** How the throwaway server rejects the stream; each is a stage a real connect fails at. */
  serve(socket: net.Socket): void;
}

const STREAM_ERROR =
  "<?xml version='1.0'?><stream:stream xmlns='jabber:client' " +
  "xmlns:stream='http://etherx.jabber.org/streams' id='s' from='parley.local' version='1.0'>" +
  "<stream:error><host-unknown xmlns='urn:ietf:params:xml:ns:xmpp-streams'/></stream:error>" +
  '</stream:stream>';

const failures: Failure[] = [
  {
    name: 'the socket is accepted and destroyed before any stream opens',
    serve: (socket) => socket.destroy(),
  },
  {
    name: 'the stream is opened and answered with a stream error',
    serve: (socket) => {
      socket.once('data', () => {
        socket.write(STREAM_ERROR);
        socket.end();
      });
    },
  },
];

/** Longer than 3x @xmpp/reconnect's ~1 s delay, so a surviving loop cannot hide inside the window. */
const OBSERVE_MS = 3_500;

const listen = (
  serve: (socket: net.Socket) => void,
): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> => {
  let count = 0;
  const server = net.createServer((socket) => {
    count++;
    socket.on('error', () => undefined);
    serve(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        connections: () => count,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
};

describe('an XMPP connect that fails leaves no live transport behind', () => {
  it.each(failures)('$name', async ({ serve }) => {
    const orphans: unknown[] = [];
    const collect = (err: unknown): void => {
      orphans.push(err);
    };
    process.on('unhandledRejection', collect);
    const server = await listen(serve);
    const plugin = new XmppPlugin();
    try {
      await expect(
        plugin.connect({
          service: `xmpp://127.0.0.1:${server.port}`,
          domain: 'parley.local',
          username: 'parley',
          password: 'a-real-secret',
        }),
      ).rejects.toThrow();

      const dialled = server.connections();
      await new Promise((r) => setTimeout(r, OBSERVE_MS));
      expect(server.connections(), 'the client kept redialling after connect() rejected').toBe(
        dialled,
      );
      expect(orphans.map(String)).toEqual([]);
    } finally {
      await plugin.disconnect();
      await server.close();
      process.off('unhandledRejection', collect);
    }
  }, 30_000);
});
