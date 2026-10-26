import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../src/index.js';

const README = new URL('../README.md', import.meta.url);
const text = readFileSync(README, 'utf8');

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
