import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../src/index.js';

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
) as { scripts?: Record<string, string>; description?: string };

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

/**
 * Every relative path this README links or names in backticks, resolved to the compose/config files
 * it points at — directly, or inside a directory it offers. Derived FROM THE README rather than
 * hand-listed, so a recipe a future README links is pulled into the rules below instead of escaping
 * them by being new.
 */
interface LinkedArtifact {
  /** The path exactly as the README writes it — the string the exposure rule looks for in prose. */
  mention: string;
  rel: string;
  text: string;
}

function linkedArtifacts(md: string): LinkedArtifact[] {
  const hrefs = [
    ...[...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ''),
    ...[...md.matchAll(/`([^`\s]*\/[^`\s]*)`/g)].map((m) => m[1] ?? ''),
  ].filter((href) => href !== '' && !/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(href));

  const out = new Map<string, LinkedArtifact>();
  for (const mention of new Set(hrefs)) {
    const target = fileURLToPath(new URL(mention.split('#')[0] ?? '', README));
    if (!existsSync(target)) continue;
    const composeFiles = statSync(target).isDirectory()
      ? readdirSync(target)
          .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
          .map((f) => `${target}/${f}`)
      : /\.ya?ml$/.test(target)
        ? [target]
        : [];
    for (const file of composeFiles) {
      out.set(file, {
        mention,
        rel: file.replace(/^.*?(?=examples\/)/, ''),
        text: readFileSync(file, 'utf8'),
      });
    }
  }
  return [...out.values()];
}

const linked = linkedArtifacts(text);

const artifacts: Array<[string, string]> = [
  ['README.md', text],
  ...readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.yaml'))
    .map((f): [string, string] => [f, readFileSync(new URL(f, EXAMPLES), 'utf8')]),
  ...linked.map((a): [string, string] => [a.rel, a.text]),
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

// CLASS: a security guard that lints only the artifacts it was written against, while the README
// links others — and, once it does look, grades the exposure prose in one direction only. A rule of
// the form "if a port is exposed the README must warn" is satisfied by doing nothing the moment every
// port is loopback, which is when the warning itself becomes the wrong claim: a reader who is told a
// harness publishes on every interface either avoids something safe, or learns to distrust this
// README's exposure claims. Both directions are graded below.

/** Every host-published port in a compose file, as written (`6379:6379`, `127.0.0.1:6379:6379`). */
function publishedPorts(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*-\s*["']?((?:\[[^\]]+\]:|[\d.]+:)?\d+:\d+)["']?/gm)].map(
    (m) => m[1] ?? '',
  );
}

const publishesOnLoopback = (spec: string): boolean => /^(127\.0\.0\.1|\[::1\]|::1):/.test(spec);

/** The blank-line-delimited README blocks naming a path — where an exposure caveat has to live. */
function paragraphsNaming(md: string, needle: string): string[] {
  return md.split(/\n\s*\n/).filter((block) => block.includes(needle));
}

describe('bridge-redis shipped artifacts — a compose file the README links is guarded too', () => {
  it('links at least one compose file, so the rows below are not vacuous', () => {
    expect(linked.map((a) => a.rel)).not.toEqual([]);
  });

  it.each(linked.map((a): [string, LinkedArtifact] => [a.rel, a]))(
    'the exposure the README claims is the exposure it publishes — %s',
    (_label, artifact) => {
      const ports = publishedPorts(artifact.text);
      expect(ports, `${artifact.rel} publishes no port at all, so this row cannot fail`).not.toEqual(
        [],
      );
      const exposed = ports.filter((spec) => !publishesOnLoopback(spec));
      const blocks = paragraphsNaming(text, artifact.mention);
      expect(
        blocks,
        `the README links ${artifact.mention} but never names it in prose, so a reader meets ` +
          `${ports.join(', ')} with no description at all`,
      ).not.toEqual([]);
      const claiming = blocks.filter((block) => /every interface/i.test(block));
      if (exposed.length > 0) {
        expect(
          claiming,
          `${artifact.rel} publishes ${exposed.join(', ')} on every interface and the README ` +
            `offers it without saying so`,
        ).not.toEqual([]);
      } else {
        expect(
          claiming,
          `${artifact.rel} publishes ${ports.join(', ')} — loopback only — but the README warns of ` +
            `every-interface exposure, so a reader either avoids something safe or stops trusting ` +
            `this README's exposure claims`,
        ).toEqual([]);
      }
      // True in both arms: the harness has no password either way, and that is what the reader has
      // to know before pointing anything at it.
      expect(
        blocks.some((block) => /unauthenticated/i.test(block)),
        `the README offers ${artifact.mention} without saying it is unauthenticated`,
      ).toBe(true);
    },
  );
});

// CLASS: a behaviour this package's suite pins but its own prose never mentions. An operator has
// only the README and the npm page, so a behaviour that lives solely in a test cannot be predicted
// by anyone who has to run this thing — and the plugin's most surprising behaviours are exactly the
// ones the mapping table's one-line summaries flatten away.

/** A behaviour the suite pins, and the phrase the README must carry for it. */
const documentedBehaviours: Array<[string, RegExp]> = [
  ['a cursor past the high-water mark self-heals', /self-heal/i],
  ['…by replaying a window OLDER than the cursor asked for', /replays the most recent/],
  ['a cursor at or below the tail is echoed back untouched', /echoed back untouched/],
  ['a cursor of no recognisable shape is rejected by name', /rejected with an error naming it/],
  ['a seam refusal names the plugin, the topic and the key', /labelled the same way, naming the plugin/],
  ['a permanent refusal stops live delivery loudly', /live delivery STOPPED/],
  ['a transient fault that never clears is reported without giving up', /live delivery DEGRADED/],
  ['a sub-millisecond long-poll budget returns immediately', /floors to nothing and returns immediately/],
  ['concurrent long polls hold a bounded number of readers', /capped at 8/],
  ['…and subscribe is not the thing being capped', /`subscribe` is not capped/],
  ['a permanent refusal fails the long poll instead of emptying it', /rather than\s+being reported as an empty long poll/],
  ['retention trims approximately, and only on write', /approximate/],
];

describe('bridge-redis README — every behaviour the suite pins is described here', () => {
  it.each(documentedBehaviours)('%s', (_label, phrase) => {
    expect(
      phrase.test(text),
      `the README never describes it — nothing matches ${String(phrase)}`,
    ).toBe(true);
  });
});

// CLASS: prose that explains a knob by a mechanism the knob is not on the path of. A knob's
// accept/reject rules are documented exhaustively here, which reads as complete while saying
// nothing an operator can act on — and round 8 found `block_ms` documented in two places as
// `subscribe`'s "shutdown re-check interval" when `disconnect()` destroys the reader socket and
// never waits for it, so lowering the knob to make shutdown responsive changes nothing but idle
// churn. Generated from CONFIG_KEYS, so a knob added later with no declared observable fails here
// instead of shipping described by nothing (or by the wrong thing).

interface KnobProse {
  /** The effect this knob actually has, which its prose must name. */
  names: RegExp;
  /**
   * A mechanism the knob is NOT on the path of. Prose may still mention the two together — that is
   * how a reader learns the knob is not the lever — but only while carrying `disclaims`.
   */
  notOnThePathOf?: { mechanism: RegExp; disclaims: RegExp };
}

const knobProse: Record<string, KnobProse> = {
  url: { names: /the server every session shares/i },
  key_prefix: { names: /one Stream per topic/i },
  block_ms: {
    names: /idle re-arm interval/i,
    notOnThePathOf: {
      mechanism: /shutdown|teardown|disconnect/i,
      disclaims: /shutdown does not\s+wait for/i,
    },
  },
  connect_timeout_ms: { names: /how long the first handshake may take/i },
  retention_days: { names: /trims entries older than the window/i },
};

describe('bridge-redis README — every knob is described by an effect it has', () => {
  it.each(CONFIG_KEYS)('%s', (knob) => {
    const rule = knobProse[knob];
    expect(
      rule,
      `no observable is declared for '${knob}', so its prose can describe anything at all`,
    ).toBeDefined();
    if (rule === undefined) return;

    const blocks = paragraphsNaming(text, knob);
    expect(blocks, `the README never mentions '${knob}'`).not.toEqual([]);
    expect(
      rule.names.test(text),
      `the README never names what '${knob}' does — nothing matches ${String(rule.names)}`,
    ).toBe(true);

    const wrong = rule.notOnThePathOf;
    if (wrong === undefined) return;
    const claiming = blocks.filter(
      (block) => wrong.mechanism.test(block) && !wrong.disclaims.test(block),
    );
    expect(
      claiming,
      `the README ties '${knob}' to ${String(wrong.mechanism)} — a mechanism it is not on the ` +
        `path of — without saying so, so an operator tunes it expecting an effect it cannot have`,
    ).toEqual([]);
  });
});

/**
 * A claim this package's prose makes about behaviour the code QUALIFIES, with the qualification it
 * must carry. Graded on every surface that ships on its own: the README renders on the npm page,
 * and `description` reaches search results and `npm view` without it.
 */
const qualifiedClaims: Array<[string, RegExp, RegExp]> = [
  ['catch-up is exclusive on `since`', /exclusive/i, /self-heal/i],
];

const prose: Array<[string, string]> = [
  ['README.md', text],
  ['package.json description', manifest.description ?? ''],
];

describe('bridge-redis shipped prose — a qualified claim is never shipped bare', () => {
  it.each(
    prose.flatMap(([where, source]) =>
      qualifiedClaims.map(
        ([claim, makes, caveat]): [string, string, RegExp, RegExp] => [
          `${where}: ${claim}`,
          source,
          makes,
          caveat,
        ],
      ),
    ),
  )('%s', (_label, source, makes, caveat) => {
    expect(makes.test(source), 'nothing here makes the claim, so this row grades nothing').toBe(
      true,
    );
    expect(caveat.test(source), 'the claim ships without its qualification').toBe(true);
  });
});
