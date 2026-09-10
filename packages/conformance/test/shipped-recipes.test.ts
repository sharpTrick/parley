import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { derivedRows, filesUnder, workspaceRoot } from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';

/**
 * A `docker run` inside a fenced block is not prose: it is a command a reader pastes, and what it
 * starts holds every message a bridge carries plus the credential that reaches it. Two properties
 * decide who else can reach that server — where the container publishes, and whether the service
 * demands a credential — and both are read off the command rather than off the sentence beside it.
 *
 * The precondition this file depends on: {@link IMAGE_CREDENTIALS} carries a row for every image a
 * recipe starts, and an image with no row FAILS. A recipe for a server nobody has written a rule
 * for is refused, so it cannot ship graded by nothing.
 *
 * Why repository-level: a package cannot be exempted from this by living somewhere else. The
 * document set is the walk, so a README added tomorrow is covered the day it lands.
 *
 * Proof it can fail: drop `127.0.0.1:` from any recipe's `-p` and the exposure rows red; drop
 * `--requirepass` from the redis recipe and the credential rows red; blind the extractor, wholly
 * or to one recipe per document, and `derivedRows` reds on the count its second walk disagrees
 * with rather than quietly registering fewer rows.
 */

const REPO = workspaceRoot();

/** Fenced code blocks only — a command a reader can paste, never a mention of one in prose. */
const fencedBlocks = (md: string): string[] =>
  [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');

interface Recipe {
  /** Repository-relative document the command ships in. */
  doc: string;
  /** The command from `docker run` onward, rejoined across `\` line continuations. */
  command: string;
}

/**
 * Every `docker run` a reader can copy out of a shipped document. Read from the `docker run` token
 * rather than from the start of the line, so a prompt (`$ `) or a privilege prefix (`sudo `) does
 * not lift the recipe out of every rule below.
 */
function shippedRecipes(): Recipe[] {
  const out: Recipe[] = [];
  for (const file of filesUnder(REPO, ['.md'])) {
    const doc = relative(REPO, file);
    for (const block of fencedBlocks(readFileSync(file, 'utf8'))) {
      const lines = block.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const at = (lines[i] ?? '').indexOf('docker run');
        if (at < 0) continue;
        let command = (lines[i] ?? '').slice(at);
        while (command.trimEnd().endsWith('\\') && i + 1 < lines.length) {
          command = `${command.trimEnd().slice(0, -1)} ${lines[++i] ?? ''}`;
        }
        out.push({ doc, command });
      }
    }
  }
  return out;
}

/** `name:tag`, which is how every shipped recipe names its image; `-p 127.0.0.1:6379:6379` is not. */
const IMAGE = /^[a-z][a-z0-9._-]*(?:\/[a-z0-9._-]+)*:[A-Za-z0-9._-]+$/;

interface Parsed {
  /** Docker's own flags: everything before the image. */
  flags: string;
  /** What the container runs: everything after the image. */
  containerCommand: string;
  image?: string;
}

/**
 * Split a recipe at its image. The halves are graded separately, so that `--user`, which is
 * docker's uid flag on the left and a service's account on the right, cannot answer for the other.
 */
function parseRecipe(command: string): Parsed {
  const tokens = command.split(/\s+/).filter((t) => t !== '');
  const at = tokens.findIndex((t) => IMAGE.test(t));
  if (at < 0) return { flags: tokens.join(' '), containerCommand: '' };
  return {
    flags: tokens.slice(0, at).join(' '),
    containerCommand: tokens.slice(at + 1).join(' '),
    image: tokens[at],
  };
}

/**
 * How each image is told to demand a credential, and which half of the command line says so. An
 * anonymous server on loopback is still readable and writable by every local user and every other
 * container on the host.
 */
const IMAGE_CREDENTIALS: Array<{
  image: RegExp;
  half: keyof Pick<Parsed, 'flags' | 'containerCommand'>;
  proof: RegExp;
}> = [
  { image: /^redis:/, half: 'containerCommand', proof: /--requirepass\s+\S|--tls-auth-clients\s+\S/ },
  { image: /^nats:/, half: 'containerCommand', proof: /--user\s+\S[\s\S]*--pass\s+\S|--auth\s+\S/ },
  { image: /^postgres:/, half: 'flags', proof: /POSTGRES_PASSWORD=\S/ },
];

/** A host-published port is reachable from wherever the host is, unless it is scoped to loopback. */
const publishedPorts = (command: string): string[] =>
  [...command.matchAll(/(?:-p|--publish)[= ]([^\s]+)/g)].map((m) => m[1] ?? '');

const LOOPBACK_SCOPED = /^(?:127\.0\.0\.1|localhost|\[::1\]):/;

/** The same fenced text counted a FLAT way, so an extractor that stops seeing a line is not the
 * thing that decides how many recipes there are. */
const mentionCount = (): number =>
  filesUnder(REPO, ['.md'])
    .flatMap((file) => fencedBlocks(readFileSync(file, 'utf8')))
    .reduce((n, block) => n + [...block.matchAll(/docker run/g)].length, 0);

describe('a docker recipe this repository ships is not insecure by default', () => {
  const rows = derivedRows(
    'every docker recipe a shipped document holds',
    () => shippedRecipes().map((r): [string, Recipe] => [`${r.doc}: ${r.command}`, r]),
    { floor: 3, witness: ['packages/bridge-redis/README.md'], size: mentionCount },
  );

  it.each(rows)(
    'publishes nothing past loopback — %s',
    (_label, recipe) => {
      for (const spec of publishedPorts(recipe.command)) {
        expect(spec, `${spec} publishes on every interface this host answers on`).toMatch(
          LOOPBACK_SCOPED,
        );
      }
      expect(
        recipe.command,
        'host networking publishes every port the container listens on, whatever -p says',
      ).not.toMatch(/--net(?:work)?[= ]host\b/);
    },
  );

  it.each(rows)(
    'starts a server that demands a credential — %s',
    (_label, recipe) => {
      const parsed = parseRecipe(recipe.command);
      expect(parsed.image, `no image in ${recipe.command}, so nothing here can be decided`)
        .toBeDefined();
      const rule = IMAGE_CREDENTIALS.find((r) => r.image.test(parsed.image ?? ''));
      expect(
        rule,
        `no credential rule for image ${String(parsed.image)}; add one rather than shipping a ` +
          'recipe whose authentication nothing grades',
      ).toBeDefined();
      if (rule === undefined) return;
      expect(
        parsed[rule.half],
        `${String(parsed.image)} is started with no credential, so anyone who reaches it reads ` +
          'every message and writes messages under any sender',
      ).toMatch(rule.proof);
    },
  );

  it.each(rows)(
    'names no literal secret — %s',
    (_label, recipe) => {
      const literal =
        /(?:--requirepass|--pass|POSTGRES_PASSWORD=|--auth)[= ]*(?!["']?[$])["']?([A-Za-z0-9._-]+)/.exec(
          recipe.command,
        );
      expect(
        literal?.[1],
        `the recipe ships the literal secret ${String(literal?.[1])}, so every deployment that ` +
          'pastes it shares one credential',
      ).toBeUndefined();
    },
  );
});
