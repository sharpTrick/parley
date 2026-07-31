import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'nats';

const allSource = (): string => {
  const dir = fileURLToPath(new URL('../src', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
};

export const SERVERS = process.env.PARLEY_NATS_SERVERS ?? '127.0.0.1:4222';

/**
 * Keys of the exported `NatsBackendConfig`, read off the source rather than listed. Keep it derived,
 * so that a field added later is policed by default instead of by someone remembering to add a row.
 */
export const declaredConfigKeys = (): string[] => {
  const body = /export interface NatsBackendConfig \{([\s\S]*?)\n\}/.exec(allSource())?.[1] ?? '';
  return [...body.matchAll(/^ {2}([a-z_]+)\??:/gm)].map((m) => m[1] as string);
};

/**
 * Host/port of `SERVERS`, for anything that has to reach the server other than through the plugin
 * (the outage proxy). Keep everything pointed at this, so that PARLEY_NATS_SERVERS can move the
 * whole suite onto a private instance instead of contending on the shared one.
 */
export function serverTarget(): { host: string; port: number } {
  const [host = '127.0.0.1', port = '4222'] = SERVERS.replace(/^nats:\/\//, '').split(':');
  return { host, port: Number(port) };
}

export async function isNatsUp(servers: string = SERVERS): Promise<boolean> {
  try {
    const nc = await connect({ servers, timeout: 1000, maxReconnectAttempts: 0 });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

export const rand = (): string => Math.random().toString(36).slice(2, 8);

/** DEL: named rather than written, so no source file here carries a literal control character. */
const DEL = String.fromCharCode(0x7f);

/**
 * The characters a NATS name may not carry. Keep this enumerated here rather than imported from the
 * plugin's fold, so that the predicate grading a composed name cannot inherit the very omission it
 * exists to catch.
 */
const CONTROL_CHARS = [...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)), DEL];
/** Every code point JS `\s` matches — the set NATS bars from a subject token. */
const WHITESPACE_CHARS = [
  0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].map((c) => String.fromCodePoint(c));

/** Illegal inside one dot-separated subject token; `.` itself is the separator, so not listed. */
export const SUBJECT_ILLEGAL = [...new Set(['*', '>', ...WHITESPACE_CHARS, ...CONTROL_CHARS])];
/** Illegal anywhere in a stream name — subjects' set plus the two path characters and `.`. */
export const STREAM_ILLEGAL = [...new Set(['.', '/', '\\', ...SUBJECT_ILLEGAL])];

const holds = (text: string, illegal: string[]): boolean => [...text].some((c) => illegal.includes(c));

export const legalSubject = (name: string): boolean =>
  name.length > 0 &&
  name.split('.').every((token) => token.length > 0 && !holds(token, SUBJECT_ILLEGAL));

export const legalStreamName = (name: string): boolean =>
  name.length > 0 && !holds(name, STREAM_ILLEGAL);

/** The sequence half of a cursor — `<stream incarnation>-<sequence>`, or the legacy bare sequence. */
export const seqOf = (cursor: string): number => Number(String(cursor).split('-').at(-1));

export async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}

export async function waitForAsync(
  cond: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for async condition');
}

/**
 * Messages the server actually holds under `prefix`, read through a connection of its own. Keep it
 * off the plugin's own naming and reads, so that a message the plugin stored but refuses to name is
 * still counted.
 */
export async function storedMessages(prefix: string, servers: string = SERVERS): Promise<number> {
  const nc = await connect({ servers });
  const jsm = await nc.jetstreamManager();
  let total = 0;
  for await (const s of jsm.streams.list()) {
    if (s.config.name.startsWith(prefix)) total += s.state.messages;
  }
  await nc.drain();
  return total;
}

/** Drop every stream this run created, so a failed test cannot leak state into the next one. */
export async function dropStreams(prefix: string, servers: string = SERVERS): Promise<void> {
  const nc = await connect({ servers });
  const jsm = await nc.jetstreamManager();
  for await (const s of jsm.streams.list()) {
    if (s.config.name.startsWith(prefix)) {
      await jsm.streams.delete(s.config.name).catch(() => undefined);
    }
  }
  await nc.drain();
}
