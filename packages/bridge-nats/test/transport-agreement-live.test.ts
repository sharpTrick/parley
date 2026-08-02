import { connect } from 'nats';
import { describe, expect, it } from 'vitest';
import { plaintextRemoteServer } from '../src/index.js';
import { isNatsUp, SERVERS } from './helpers.js';

// Class: no safety answer may be decided by something the DRIVER discards. `plaintextRemoteServer`
// once read the URL scheme and excused `tls://`, `wss://` and every scheme it did not recognise —
// but nats.js strips the scheme in `hostPort()` and picks its transport from `tls` and the server's
// INFO alone, so those addresses dialled the same plain TCP socket as `nats://` while suppressing
// the warning that said the credential was in the clear.
//
// Graded against the driver rather than against a list of schemes, so that this cannot rot the way
// a literal set does: the oracle is the socket nats.js actually opened. Restoring any scheme
// allowlist fails this file even if the allowlist and the test agree with each other, because the
// live half reads the transport instead of the table. Its own FILE so a server that failed to come
// up trips CI's whole-file skip gate rather than silently deleting the coverage.
const SCHEMES = ['nats://', 'ws://', '', 'tls://', 'wss://', 'nats+tls://', 'http://', 'gopher://'];

/** The socket nats.js opened for `server`, and whether it negotiated TLS on it. */
async function dialEncrypted(server: string): Promise<boolean> {
  const nc = await connect({ servers: server, timeout: 2000, maxReconnectAttempts: 0 });
  try {
    const socket = (nc as unknown as { protocol: { transport: { socket: { encrypted?: boolean } } } })
      .protocol.transport.socket;
    return socket.encrypted === true;
  } finally {
    await nc.close();
  }
}

const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats transport safety — the classifier agrees with the driver, not with a scheme list', () => {
  const { host, port } = ((): { host: string; port: string } => {
    const [h = '127.0.0.1', p = '4222'] = SERVERS.replace(/^[a-z+]+:\/\//i, '').split(':');
    return { host: h, port: p };
  })();

  it.each(SCHEMES)(
    'scheme %j reaches this server unencrypted, so the same scheme must never excuse a remote host',
    async (scheme) => {
      const encrypted = await dialEncrypted(`${scheme}${host}:${port}`);

      // The oracle: what the driver did. A scheme that bought no encryption may not buy silence.
      expect(encrypted).toBe(false);
      expect(plaintextRemoteServer(`${scheme}nats.example.com:4222`)).toBeDefined();
    },
    15_000,
  );

  // The other half of the agreement: `tls` is the one signal that actually forces encryption, and
  // it does so by FAILING against a server that offers none rather than falling back to plaintext.
  it('backend_config.tls is fail-fast against a server with no TLS, never a silent downgrade', async () => {
    const err = await connect({
      servers: `${host}:${port}`,
      tls: {},
      timeout: 2000,
      maxReconnectAttempts: 0,
    }).then(
      (nc) => {
        void nc.close();
        return undefined;
      },
      (e: unknown) => e,
    );

    expect(String(err)).toContain('tls');
  }, 15_000);
});
