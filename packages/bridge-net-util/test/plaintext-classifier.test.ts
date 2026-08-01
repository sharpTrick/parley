import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '@sharptrick/parley-net-util';
import { isLoopbackHost, plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import { consumerPackageSources, importingFiles, SELF } from './consumers.js';

/**
 * A security predicate whose negative answer means "no plaintext-credential risk" may not answer it
 * for a scheme it has never met. `http:` was the only scheme tested, so `ws:` — how Discord's
 * gateway and Slack's Socket Mode carry a bot token — classified as safe, and the one backend that
 * needed the answer had to build its own classifier rather than fix this one.
 *
 * Crossed with the host axis because the two rules compose: the scheme decides whether a credential
 * would be in the clear, the host decides whether it leaves the machine. A cell is the only place a
 * new scheme's classification can be stated, so a scheme added to either side arrives as a row.
 */
const SCHEMES: [scheme: string, cleartext: boolean][] = [
  ['http', true],
  ['ws', true],
  ['https', false],
  ['wss', false],
  // Nothing in the repo dials this today. It is the row that decides the DIRECTION the classifier
  // fails in: an unrecognized scheme is unproven, and an unproven scheme gets the warning.
  ['x-vendor-stream', true],
];

const HOSTS: [host: string, loopback: boolean][] = [
  ['evil.example.com', false],
  ['10.0.0.4:8443', false],
  // Shaped like a loopback address, resolvable as an ordinary name — classified by what it is.
  ['127.0.0.1.example.com', false],
  ['localhost.example.com', false],
  // An IPv4-mapped spelling of a loopback address (as `URL` normalizes it): unproven, so warned
  // about.
  ['[::ffff:7f00:1]', false],
  ['localhost', true],
  ['localhost:9991', true],
  ['127.0.0.1:8080', true],
  ['127.9.9.9', true],
  ['[::1]:6667', true],
];

describe('plaintextRemoteOrigin', () => {
  it('crosses two axes that both discriminate, so the rows below are not one rule', () => {
    expect(new Set(SCHEMES.map(([, cleartext]) => cleartext))).toEqual(new Set([true, false]));
    expect(new Set(HOSTS.map(([, loopback]) => loopback))).toEqual(new Set([true, false]));
  });

  it.each(
    SCHEMES.flatMap(([scheme, cleartext]) =>
      HOSTS.map(([host, loopback]) => [`${scheme}://${host}`, cleartext && !loopback] as const),
    ),
  )('%s warns: %s', (base, warns) => {
    const named = plaintextRemoteOrigin(`${base}/some/path`);
    expect(named).toBe(warns ? base : undefined);
  });

  // The origin, not the configured URL: a secret smuggled into a path or the userinfo must not be
  // what stderr — and the tool result core hands the model — prints.
  it.each([
    ['a path secret', 'http://evil.example.com/bot123:SECRET-CANARY/getMe', 'http://evil.example.com'],
    ['a query secret', 'ws://evil.example.com/gw?token=SECRET-CANARY', 'ws://evil.example.com'],
    ['userinfo', 'http://user:SECRET-CANARY@evil.example.com:8080/p', 'http://evil.example.com:8080'],
  ])('names only the origin for %s', (_label, url, origin) => {
    const named = plaintextRemoteOrigin(url);
    expect(named).toBe(origin);
    expect(named).not.toContain('SECRET-CANARY');
  });

  it.each([
    ['not a url at all', 'not a url'],
    ['a scheme with no host', 'file:///etc/passwd'],
    ['a mail address', 'mailto:ops@example.com'],
    ['an empty string', ''],
  ])('answers undefined for %s, which names no remote endpoint', (_label, value) => {
    expect(plaintextRemoteOrigin(value)).toBeUndefined();
  });
});

describe('isLoopbackHost', () => {
  it.each(HOSTS.map(([host, loopback]) => [host, loopback] as const))(
    '%s is loopback: %s',
    (host, loopback) => {
      // The host axis carries a port where a real config would; the predicate takes a hostname.
      expect(isLoopbackHost(new URL(`http://${host}`).hostname)).toBe(loopback);
    },
  );

  it.each([
    ['LOCALHOST', true],
    ['LocalHost', true],
    ['[::1]', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::1', true],
    ['127.0.0.1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['[::ffff:7f00:1]', false],
    ['example.com', false],
    ['', false],
  ])('classifies the literal %s as loopback: %s', (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});

/**
 * The claim the README makes about this whole section: the backends that warn about the same thing
 * share ONE classifier, because a security predicate copied per backend is a predicate fixed in one
 * place and left wrong in the others. That is a claim about the repo, and only a scan of the repo
 * can hold it — `bridge-discord` imports `isLoopbackHost` from here and re-implements
 * `plaintextRemoteOrigin` with the opposite fail direction, which no test in either package could
 * see. Every fork that exists today is recorded BY NAME below, so the next one fails here.
 */
describe('no consumer re-implements an export of this package', () => {
  /**
   * The forks in the repo as it stands, each with why it is not simply an import. A row here is a
   * debt this package has accepted, not a licence: adding one is a deliberate edit to this table.
   */
  const KNOWN_FORKS: Record<string, string> = {
    'bridge-discord:plaintextRemoteOrigin':
      'it needs the scheme to recommend as well as the origin to name, which a ' +
      '`string | undefined` return cannot carry — widening the return is what retires it',
    'bridge-nats:delay':
      'a duplicate with no obstruction at all: importing `delay` from here is a one-line change ' +
      'in that package, which owns it',
    'bridge-redis:delay':
      'a duplicate with no obstruction at all: importing `delay` from here is a one-line change ' +
      'in that package, which owns it',
  };

  /**
   * `<package>:<name>` for every MODULE-LEVEL declaration whose name collides with an export of this
   * module. Anchored at column zero: a block-scoped `const delay = stanza.getChild('delay', …)` is a
   * local binding that happens to share a word, not a second implementation of a shared helper.
   */
  const forks = (root?: URL, selfDir?: string): string[] => {
    const exported = new Set(Object.keys(api));
    const out: string[] = [];
    for (const { pkg, code } of consumerPackageSources(root, selfDir)) {
      for (const m of code.matchAll(
        /^(?:export )?(?:async )?(?:function|const|class) (\w+)/gm,
      )) {
        if (exported.has(m[1] as string)) out.push(`${pkg}:${m[1] as string}`);
      }
    }
    return [...new Set(out)];
  };

  it('reads consumers and exports at all, so the rows below are not scanning nothing', () => {
    expect(consumerPackageSources().length).toBeGreaterThan(5);
    expect(Object.keys(api).length).toBeGreaterThan(5);
  });

  /**
   * The scan against the tree shape it has to survive, on a SYNTHETIC root rather than on
   * `packages/` — the repo's own layout is what a check like this comes to depend on silently, and a
   * flat listing graded green here for as long as no consumer nested a file. Both directions are
   * graded: a fork one level down must be REPORTED, and a package whose only import of this one
   * lives in a subdirectory must still be scanned at all.
   */
  describe('the scan reaches a nested file', () => {
    const plant = (files: Record<string, string>): URL => {
      const root = pathToFileURL(`${mkdtempSync(join(tmpdir(), 'net-util-scan-'))}/`);
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(new URL(`./${dirname(path)}/`, root), { recursive: true });
        writeFileSync(new URL(`./${path}`, root), body);
      }
      return root;
    };

    const IMPORTS_SELF = `import { isLoopbackHost } from '${SELF}';\nvoid isLoopbackHost;\n`;
    const A_FORK = 'export const plaintextRemoteOrigin = (u: string) => u;\n';
    const NO_SELF_DIR = 'nothing-here';

    it('reports a fork nested below src/', () => {
      const root = plant({
        'fake-consumer/src/index.ts': IMPORTS_SELF,
        'fake-consumer/src/deep/inner/dup.ts': A_FORK,
      });
      expect(forks(root, NO_SELF_DIR)).toContain('fake-consumer:plaintextRemoteOrigin');
    });

    it('counts a package whose only import of this one is nested', () => {
      const root = plant({
        'fake-consumer/src/deep/uses.ts': IMPORTS_SELF,
        'fake-consumer/src/dup.ts': A_FORK,
      });
      expect(forks(root, NO_SELF_DIR)).toContain('fake-consumer:plaintextRemoteOrigin');
    });

    it('reports nothing for a package that does not import this one', () => {
      const root = plant({ 'stranger/src/deep/dup.ts': A_FORK });
      expect(forks(root, NO_SELF_DIR)).toEqual([]);
    });

    // A package may name this one in a table of packages it must NOT depend on. Reading that as an
    // import turns every same-named local helper it owns into a fork of an export it is forbidden
    // to import — which is what `bridge-core`'s licence-gap list did the moment the scan recursed.
    it('reports nothing for a package that only lists this one by name', () => {
      const root = plant({
        'lister/src/table.ts': `const FORBIDDEN = [\n  '${SELF}',\n];\nvoid FORBIDDEN;\n`,
        'lister/src/deep/dup.ts': A_FORK,
      });
      expect(forks(root, NO_SELF_DIR)).toEqual([]);
    });

    // The other scan built on the same listing: the dead-export check reads `src/` AND `test/`, and
    // a live import it cannot see reads as an export nothing consumes.
    it('finds an importer nested below src/ or test/', () => {
      const root = plant({
        'fake-consumer/src/deep/uses.ts': IMPORTS_SELF,
        'fake-consumer/test/deep/also.ts': IMPORTS_SELF,
        'fake-consumer/src/quiet.ts': 'export const nothing = 1;\n',
      });
      expect(
        importingFiles(root, NO_SELF_DIR)
          .map(({ path }) => path)
          .sort(),
      ).toEqual(['fake-consumer/src/deep/uses.ts', 'fake-consumer/test/deep/also.ts']);
    });
  });

  it('every local copy of a shared name is one this package has recorded', () => {
    expect(
      forks().filter((fork) => !(fork in KNOWN_FORKS)),
      'a consumer defines its own copy of a name this package exports — import the shared one, or ' +
        'record here why it cannot be imported',
    ).toEqual([]);
  });

  it('every recorded fork still exists, so the table cannot outlive the debt', () => {
    expect(Object.keys(KNOWN_FORKS).filter((fork) => !forks().includes(fork))).toEqual([]);
  });

  // The README names one of these forks in prose, which rots the day it is retired. Pinned to the
  // table rather than left as a claim nothing reads: a package the prose calls a fork must be one.
  it('the README names no fork this table does not record', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const paragraph = readme.split(/\n\s*\n/).find((p) => p.includes('fork'));
    expect(paragraph, 'the README no longer says anything about forks').toBeDefined();
    const named = [...(paragraph as string).matchAll(/`(bridge-[\w-]+)`/g)].map(
      (m) => m[1] as string,
    );
    const recorded = new Set(Object.keys(KNOWN_FORKS).map((fork) => fork.split(':')[0] as string));
    expect(named).not.toEqual([]);
    expect(named.filter((pkg) => !recorded.has(pkg))).toEqual([]);
  });
});
