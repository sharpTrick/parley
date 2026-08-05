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
 * see.
 *
 * Two scans, because one of them was keyed on NAME COLLISION with an export of this module and a
 * fork that picks a different identifier is invisible to it. `bridge-xmpp` had one: an
 * `isPlaintextRemote` carrying its own `/^127(\.\d{1,3}){3}$/`, which read the registrable
 * hostnames `127.999.999.999` and `127.00.0.1` as loopback and silenced the only warning on a path
 * where SASL PLAIN is registered unconditionally. So the second scan asks what a declaration DOES:
 * a module-level function that decides something about a loopback address, and does not ask this
 * module, is a fork whatever it is called.
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

  /**
   * A loopback literal in a decision. Anchored on what the classification is MADE of rather than on
   * what the function is called: `isPlaintextRemote`, `plaintextRemoteServer` and `isLoopbackHost`
   * are three names for one question, and only the third collides with an export here.
   */
  const LOOPBACK_LITERAL = /'localhost'|"localhost"|`localhost`|\b127\.\d|::1/;
  const DELEGATES = /\b(?:isLoopbackHost|plaintextRemoteOrigin)\s*\(/;

  /** A module-level declaration and the source down to the next one — its body, near enough. */
  const declarations = (code: string): { name: string; body: string }[] => {
    const heads = [
      ...code.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|class|let)\s+([\w$]+)/gm),
    ];
    return heads.map((m, i) => ({
      name: m[1] as string,
      body: code.slice(
        m.index as number,
        i + 1 < heads.length ? (heads[i + 1] as RegExpMatchArray).index : code.length,
      ),
    }));
  };

  /** Whether the declaration is a function at all — a default `'xmpp://127.0.0.1'` decides nothing. */
  const isFunction = (body: string): boolean =>
    /^(?:export\s+)?(?:async\s+)?function\s/.test(body) ||
    /=\s*(?:async\s+)?function\b/.test(body) ||
    /=\s*(?:async\s*)?\(?[\w$,\s:]*\)?\s*(?::[^=]*)?=>/.test(body);

  /** `<package>:<name>` for every function that classifies a loopback host without asking here. */
  const classifiers = (root?: URL, selfDir?: string): string[] => {
    const out: string[] = [];
    for (const { pkg, code } of consumerPackageSources(root, selfDir)) {
      for (const { name, body } of declarations(code)) {
        if (isFunction(body) && LOOPBACK_LITERAL.test(body) && !DELEGATES.test(body)) {
          out.push(`${pkg}:${name}`);
        }
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

  it('no consumer decides a loopback host without asking this module', () => {
    expect(
      classifiers().filter((fork) => !(fork in KNOWN_FORKS)),
      'this function classifies a loopback address on its own — call isLoopbackHost, or record ' +
        'here why it cannot',
    ).toEqual([]);
  });

  /**
   * The scan that matters most is the one with nothing left to find, so it is run against a tree
   * built to contain the shape. Both directions: a differently-named fork must be REPORTED, and a
   * function that delegates, or a constant that merely spells an address, must not.
   */
  describe('a fork under a name this module does not export', () => {
    const plantConsumer = (body: string): URL => {
      const root = pathToFileURL(`${mkdtempSync(join(tmpdir(), 'net-util-fork-'))}/`);
      mkdirSync(new URL('./fake-consumer/src/', root), { recursive: true });
      writeFileSync(
        new URL('./fake-consumer/src/index.ts', root),
        `import { fetchWithRetry } from '${SELF}';\nvoid fetchWithRetry;\n`,
      );
      writeFileSync(new URL('./fake-consumer/src/config.ts', root), body);
      return root;
    };

    it.each([
      [
        'a differently-named loopback classifier',
        "export function isPlaintextRemote(h: string): boolean {\n  return !(h === 'localhost' || /^127\\./.test(h));\n}\n",
        true,
      ],
      [
        'an arrow function deciding the same thing',
        "const safe = (h: string): boolean => h === 'localhost' || h === '::1';\n",
        true,
      ],
      [
        'a function that asks this module instead',
        "export function isPlaintextRemote(h: string): boolean {\n  // 127.0.0.1 is the default\n  return !isLoopbackHost(h);\n}\n",
        false,
      ],
      ['a default value that spells an address', "export const DEFAULT = 'xmpp://127.0.0.1:5222';\n", false],
      ['a function with no loopback literal in it', 'export function f(x: string): string {\n  return x;\n}\n', false],
    ])('%s is reported: %s', (_label, body, reported) => {
      const found = classifiers(plantConsumer(body), 'nothing-here');
      expect(found.length > 0).toBe(reported);
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
