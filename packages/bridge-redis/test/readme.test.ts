import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// CLASS: a shipped infra recipe must not be insecure by default. A copy-pasteable `docker run`
// that publishes a port on every interface hands an unauthenticated Redis — full message history,
// forged `sender`s, the CONFIG SET write primitive — to anyone who can route to the host, and
// Docker's own iptables rules mean a host firewall does not save the reader.

const README = new URL('../README.md', import.meta.url);
const text = readFileSync(README, 'utf8');

/** Every `docker run` invocation, rejoined across `\` line continuations. */
function dockerRunCommands(md: string): string[] {
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*docker run\b/.test(lines[i] ?? '')) continue;
    let cmd = lines[i] ?? '';
    while (cmd.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      cmd = `${cmd.trimEnd().slice(0, -1)} ${lines[++i] ?? ''}`;
    }
    out.push(cmd);
  }
  return out;
}

describe('bridge-redis README — shipped infra recipes must not be insecure by default', () => {
  const commands = dockerRunCommands(text);

  it('documents at least one docker run recipe', () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  it.each(commands)('binds every published port to loopback: %s', (cmd) => {
    const published = [...cmd.matchAll(/(?:-p|--publish)[= ]([^\s]+)/g)].map((m) => m[1] ?? '');
    for (const spec of published) {
      expect(spec, `${spec} publishes on every interface`).toMatch(/^(127\.0\.0\.1|\[?::1]?):/);
    }
  });

  it.each(commands)('requires authentication: %s', (cmd) => {
    expect(cmd).toMatch(/--requirepass|--tls-auth-clients|--user\b/);
  });

  it('carries a credentials section covering the password, .env and TLS', () => {
    expect(text).toMatch(/##\s+Credentials & exposure/);
    expect(text).toMatch(/requirepass/);
    expect(text).toMatch(/rediss:\/\//);
    expect(text).toMatch(/\.env/);
  });

  it('never hard-codes a literal password next to requirepass', () => {
    for (const cmd of commands) {
      const literal = /--requirepass[= ]+(?!["']?\$)["']?([A-Za-z0-9._-]+)/.exec(cmd);
      expect(literal?.[1], `README ships the literal password ${literal?.[1]}`).toBeUndefined();
    }
  });
});

// CLASS: a shipped command cannot run where the README that ships it lives. This README goes to
// npm, where the package directory is the only context a reader has, so an `npm run` line naming a
// script this package does not declare fails on the first thing a new contributor tries.

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts?: Record<string, string> };

/** Every `npm test` / `npm run <script>` line in the README, with leading env assignments stripped. */
function npmScriptInvocations(md: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of md.split('\n')) {
    const command = line.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, '');
    const invocation = /^npm\s+(?:run\s+(?:--\s+)?([\w:-]+)|(test|start))\b/.exec(command);
    if (invocation === null) continue;
    out.push([line.trim(), invocation[1] ?? invocation[2] ?? '']);
  }
  return out;
}

describe('bridge-redis README — every documented npm command runs from this package', () => {
  const invocations = npmScriptInvocations(text);
  const scripts = Object.keys(manifest.scripts ?? {});

  it('documents at least one npm command', () => {
    expect(invocations.length).toBeGreaterThan(0);
  });

  it.each(invocations)('%s names a script this package declares', (line, script) => {
    if (/\s(?:-w|--workspace)[=\s]/.test(line)) return; // explicitly repo-root-scoped
    expect(scripts, `README ships '${line}', but there is no '${script}' script here`).toContain(
      script,
    );
  });
});

// CLASS: a shipped copy-pasteable artifact contradicts the package's own security guidance. The
// docker recipes above are only one such artifact — the runnable example configs the README links
// to are the ones an operator actually copies, and nothing was checking them.

const EXAMPLES = new URL('../../../examples/multi-session/redis/', import.meta.url);

interface ShippedUrl {
  where: string;
  raw: string;
  scheme: string;
  credentials: string;
  host: string;
}

/** Every `redis://` / `rediss://` URL a reader could copy out of a shipped artifact. */
function shippedUrls(where: string, source: string): ShippedUrl[] {
  const url = /\b(rediss?):\/\/(?:([^@\s/"'`]*)@)?([A-Za-z0-9._[\]-]+)/g;
  return [...source.matchAll(url)].map((m) => ({
    where,
    raw: m[0] ?? '',
    scheme: m[1] ?? '',
    credentials: m[2] ?? '',
    host: m[3] ?? '',
  }));
}

const artifacts: Array<[string, string]> = [
  ['README.md', text],
  ...readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.yaml'))
    .map((f): [string, string] => [f, readFileSync(new URL(f, EXAMPLES), 'utf8')]),
];

const shipped = artifacts.flatMap(([where, source]) => shippedUrls(where, source));

const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';

describe('bridge-redis shipped artifacts — every copy-pasteable URL follows the README', () => {
  it('ships at least one example config and one README URL', () => {
    expect(artifacts.length).toBeGreaterThan(1);
    expect(shipped.length).toBeGreaterThan(0);
  });

  it.each(shipped.map((u): [string, ShippedUrl] => [`${u.where}: ${u.raw}`, u]))(
    'is loopback, or TLS with credentials — %s',
    (_label, u) => {
      if (isLoopback(u.host)) return;
      expect(u.scheme, `${u.raw} sends a shared history and forged-sender writes over plaintext`).toBe(
        'rediss',
      );
      expect(u.credentials, `${u.raw} points at an unauthenticated Redis`).not.toBe('');
    },
  );
});
