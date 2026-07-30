import net from 'node:net';
import { MAX_ERROR_BODY } from '@sharptrick/parley-net-util';
import { expect } from 'vitest';

// The in-process RESP server every "reachable but hostile" case in this package drives, plus the
// grammar a REAL Redis words its refusals in and the invariants that must hold of anything the
// plugin builds out of a server's own text. Shared, so that a row's wording is a property of the
// PROTOCOL rather than of what a test author typed: a fake that answers `-ERR unknown command` with
// no arguments cannot produce the failure mode that matters, and every assertion built on it grades
// a server tamer than any real one.

const CRLF = Buffer.from('\r\n');

/**
 * One RESP command, or `undefined` while `buf` still holds a partial one.
 *
 * Keep the parse on BYTES, so that a bulk-string length is read the way RESP means it: a `pässwörd`
 * argument is 8 characters and 10 bytes, and a parser that slices a decoded string by the declared
 * length silently mis-frames every command after the first non-ASCII one.
 */
function takeCommand(buf: Buffer): { consumed: number; argv: string[] } | undefined {
  const head = buf.indexOf(CRLF);
  if (head === -1) return undefined;
  if (buf[0] !== 0x2a /* '*' */) {
    return { consumed: head + 2, argv: [buf.toString('utf8', 0, head)] };
  }
  const argc = Number(buf.toString('latin1', 1, head));
  let at = head + 2;
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    if (buf[at] !== 0x24 /* '$' */) return undefined;
    const lenEnd = buf.indexOf(CRLF, at);
    if (lenEnd === -1) return undefined;
    const len = Number(buf.toString('latin1', at + 1, lenEnd));
    const start = lenEnd + 2;
    if (buf.length < start + len + 2) return undefined;
    argv.push(buf.toString('utf8', start, start + len));
    at = start + len + 2;
  }
  return { consumed: at, argv };
}

export interface RespEndpoint {
  url: string;
  close: () => void;
}

/**
 * A TCP endpoint that speaks enough RESP to complete node-redis' handshake and then answers each
 * command with whatever `reply` returns (`undefined` = stay silent). In-process, so every case
 * built on it needs no container and cannot skip itself.
 */
export async function respEndpoint(
  reply: (argv: string[]) => string | undefined,
): Promise<RespEndpoint> {
  const held: net.Socket[] = [];
  const server = net.createServer((sock) => {
    held.push(sock);
    let buf = Buffer.alloc(0);
    sock.on('error', () => undefined);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const cmd = takeCommand(buf);
        if (cmd === undefined) break;
        buf = buf.subarray(cmd.consumed);
        const out = reply(cmd.argv);
        if (out !== undefined) sock.write(out, 'utf8');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}`,
    close: () => {
      for (const s of held) s.destroy();
      server.close();
    },
  };
}

export const commandOf = (argv: string[]): string => (argv[0] ?? '').toLowerCase();

/** The password every hostile-server case puts in its URL, so every one can fail on leaking it. */
export const SECRET = 'hunter2';

/**
 * How Redis itself quotes the arguments it was given back at the client — `, with args beginning
 * with: 'hunter2', 'CLIENT', ` — which is what a real server appends to an unknown-command refusal,
 * and therefore what it hands back when `AUTH` is the command it did not know.
 */
export const withArgs = (argv: string[]): string =>
  `, with args beginning with: ${argv
    .slice(1)
    .map((arg) => `'${arg}', `)
    .join('')}`;

/** A RESP error line. */
export const respError = (code: string, text: string): string => `-${code} ${text}\r\n`;

/** Replies that let the plugin get as far as the command a case actually wants refused. */
export const DEFAULT_REPLIES: Record<string, string> = {
  ping: '+PONG\r\n',
  exists: ':0\r\n',
  xadd: '$3\r\n1-0\r\n',
  xrange: '*0\r\n',
  xrevrange: '*0\r\n',
  xread: '*-1\r\n',
  xinfo: '*2\r\n$17\r\nlast-generated-id\r\n$3\r\n9-0\r\n',
};

/**
 * `sanitizeBody`'s ceiling plus the room the plugin's own label needs around it. A message past
 * this carries server text nothing bounded.
 */
export const SAFE_LENGTH = MAX_ERROR_BODY + 512;

/**
 * Every control (`Cc`) and format (`Cf`) character, plus the two separators that are neither: what
 * a hostile reply forges line structure, ANSI colour or bidi reordering out of.
 */
const FORGES_LINE_STRUCTURE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/**
 * The invariants that hold of anything this plugin builds out of server-supplied text, whatever the
 * server put in it: it never carries the connection's own credential, it is bounded, and it cannot
 * forge line structure in an operator's log or in an MCP tool result.
 */
export function expectSafeFromServer(what: string, text: string, secret: string): void {
  expect(text, `${what} carries the credential`).not.toContain(secret);
  expect(text.length, `${what} is unbounded (${text.length} chars)`).toBeLessThanOrEqual(
    SAFE_LENGTH,
  );
  expect(
    FORGES_LINE_STRUCTURE.test(text),
    `${what} carries a control or format character`,
  ).toBe(false);
}

/**
 * The same invariants against a thrown error — over its `stack` too, since that is what `cli.ts`
 * writes to stderr. Only the credential invariant applies to the stack: Node owns its newlines.
 */
export function expectSafeError(what: string, err: Error | undefined, secret: string): void {
  expect(err, `${what} accepted a hostile reply instead of surfacing it`).toBeInstanceOf(Error);
  expectSafeFromServer(what, err?.message ?? '', secret);
  expect(err?.stack ?? '', `${what}'s stack carries the credential`).not.toContain(secret);
}
