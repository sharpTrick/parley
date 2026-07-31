import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asTopic, type Topic, DEFAULT_HASH_LEN } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { AGREEMENT_ROWS } from './jetstream-agreement.js';

// Class: a public claim must be mechanically tied to the code. README/npm text drifts silently —
// a reader who believes the wrong claim builds on semantics the plugin does not have — so the
// documented names are recomputed here and the retired claims are asserted gone.
// The sharpest form of the drift is a claim asserting a PROPERTY the code spends its length
// defending against the absence of: the package shipped "contiguous" to npm while its own window
// tests tabled six sparse streams and the reader who sized a page as `last_seq - since` paid for
// it. Those words are banned across every public surface — README, the npm description, and the
// source JSDoc that becomes the published types.
const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const readme = read('../README.md');
const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, text: readFileSync(join(srcDir, f), 'utf8') }));
const manifest = JSON.parse(read('../package.json')) as { description: string; keywords: string[] };

const names = (topic: Topic): { subject: string; stream: string } => {
  const plugin = new NatsPlugin() as unknown as {
    subject: (t: Topic) => string;
    streamName: (t: Topic) => string;
  };
  return { subject: plugin.subject(topic), stream: plugin.streamName(topic) };
};

// Exactly the rows of the README's "Topic → subject / stream names" table.
const documented = [
  { topic: 'deploys', subject: 'parley.deploys', stream: 'PARLEY_deploys' },
  { topic: 'team.chat', subject: 'parley.team_chat-<sha1>', stream: 'PARLEY_team_chat-<sha1>' },
  { topic: 'ops/oncall', subject: 'parley.ops/oncall', stream: 'PARLEY_ops_oncall-<sha1>' },
  { topic: 'red team', subject: 'parley.red_team-<sha1>', stream: 'PARLEY_red_team-<sha1>' },
];

// The README spells the suffix width out, so read it at the width core actually mints — a change to
// DEFAULT_HASH_LEN then fails here as doc drift instead of passing against a stale literal.
const atDocumentedWidth = (name: string): string =>
  name.replace('<sha1>', `<sha1-${DEFAULT_HASH_LEN}>`);

const asPattern = (documentedName: string): RegExp =>
  new RegExp(
    `^${documentedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('<sha1>', `[0-9a-f]{${DEFAULT_HASH_LEN}}`)}$`,
  );

describe('nats docs conformance', () => {
  for (const row of documented) {
    it(`README documents the real subject/stream names for \`${row.topic}\``, () => {
      expect(readme).toContain(
        `| \`${row.topic}\` | \`${atDocumentedWidth(row.subject)}\` | \`${atDocumentedWidth(row.stream)}\` |`,
      );
      const actual = names(asTopic(row.topic));
      expect(actual.subject).toMatch(asPattern(row.subject));
      expect(actual.stream).toMatch(asPattern(row.stream));
    });
  }

  // The live consumer is a plain named ephemeral one plus an explicit rebuild watcher; calling it
  // "ordered" promises nats.js OrderedConsumer semantics (automatic gap detection and reset).
  const retired = ['ordered consumer', 'DeliverPolicy.New'];
  for (const claim of retired) {
    it(`neither the README nor the npm description claims "${claim}"`, () => {
      expect(readme.toLowerCase()).not.toContain(claim.toLowerCase());
      expect(manifest.description.toLowerCase()).not.toContain(claim.toLowerCase());
    });
  }

  // Properties the code explicitly handles the ABSENCE of. Claiming one is worse than saying
  // nothing: it invites the reader to compute a count from `last_seq - since`, or to treat the
  // sequence as an id that never repeats across a re-provisioned stream.
  const bannedProperties = ['contiguous', 'dense', 'gapless', 'unbroken', 'consecutive'];
  const surfaces = [
    { name: 'README.md', text: readme },
    { name: 'the npm description', text: manifest.description },
    ...sources.map((f) => ({ name: `src/${f.name}`, text: f.text })),
  ];
  /** Occurrences of `word` that ASSERT it — a negated mention is the text doing its job. */
  const assertions = (text: string, word: string): string[] => {
    const found: string[] = [];
    for (const m of text.matchAll(new RegExp(`\\b${word}\\b`, 'gi'))) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
      if (!/\b(not|never|non)\b[\s*_-]*$/i.test(before)) {
        found.push(text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + word.length));
      }
    }
    return found;
  };

  for (const surface of surfaces) {
    for (const claim of bannedProperties) {
      it(`${surface.name} does not claim the sequence is "${claim}"`, () => {
        expect(assertions(surface.text, claim)).toEqual([]);
      });
    }
  }

  it('the banned-claim check reads a claim and spares its negation', () => {
    expect(assertions('the range is dense', 'dense')).toHaveLength(1);
    expect(assertions('the range is **not** dense', 'dense')).toEqual([]);
    expect(assertions('sequences are never contiguous', 'contiguous')).toEqual([]);
  });

  // Class: prose that asserts a concrete SERVER behaviour. A banned word list cannot reach these —
  // the two that shipped ("2.10 answers `last_by_subj` with 404 once the subject's newest has been
  // deleted", "asking below `first_seq` stalls the pull for its whole expiry") used no banned word
  // and were simply false, and each was load-bearing: one justified a fall back the server almost
  // never selects, the other justified a clamp for a reason the clamp does not have. So every prose
  // line naming a JetStream primitive must be registered here against a row of
  // `jetstream-agreement.ts`, which is asserted against a real server. A new claim arrives
  // unregistered and fails this test rather than shipping unverified.
  const JETSTREAM_PRIMITIVES = ['last_by_subj', 'opt_start_seq', 'first_seq'];

  /** Comment lines in source; README text outside a fenced block. Code is not a claim. */
  const proseLines = (surface: { name: string; text: string }): string[] => {
    const markdown = surface.name.endsWith('.md');
    const out: string[] = [];
    let fenced = false;
    for (const line of surface.text.split('\n')) {
      if (markdown) {
        if (/^\s*```/.test(line)) fenced = !fenced;
        else if (!fenced) out.push(line);
        continue;
      }
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) out.push(line);
    }
    return out;
  };

  const serverClaims: { surface: string; text: string; verifiedBy: string }[] = [
    {
      surface: 'README.md',
      text: 'ephemeral consumer from `opt_start_seq = since+1` (exclusive)',
      verifiedBy: 'a pull sees only its filter_subject, from its opt_start_seq',
    },
    {
      surface: 'src/index.ts',
      text: '`fetchRecent` = an ephemeral consumer from `opt_start_seq`',
      verifiedBy: 'a pull sees only its filter_subject, from its opt_start_seq',
    },
    {
      surface: 'src/index.ts',
      text: 'the one shape `last_by_subj` answers with a 404',
      verifiedBy: 'last_by_subj on a subject that never had a message is not found',
    },
    {
      surface: 'src/index.ts',
      text: 'a pull below `first_seq` starts at the',
      verifiedBy: 'a pull below first_seq starts at the first surviving sequence instead of stalling',
    },
  ];

  const claimSurfaces = [
    { name: 'README.md', text: readme },
    ...sources.map((f) => ({ name: `src/${f.name}`, text: f.text })),
  ];

  it('finds the prose it is meant to police', () => {
    const marked = claimSurfaces.flatMap((s) =>
      proseLines(s).filter((l) => JETSTREAM_PRIMITIVES.some((p) => l.includes(p))),
    );
    expect(marked.length).toBeGreaterThanOrEqual(serverClaims.length);
    expect(proseLines({ name: 'x.ts', text: '  const a = first_seq;' })).toEqual([]);
  });

  for (const claim of serverClaims) {
    it(`the claim "${claim.text}" is in ${claim.surface} and is probed live`, () => {
      const surface = claimSurfaces.find((s) => s.name === claim.surface);
      expect(surface?.text).toContain(claim.text);
      expect(AGREEMENT_ROWS.map((r) => r.name)).toContain(claim.verifiedBy);
    });
  }

  for (const surface of claimSurfaces) {
    it(`every ${surface.name} claim naming a JetStream primitive is registered`, () => {
      const unregistered = proseLines(surface)
        .filter((line) => JETSTREAM_PRIMITIVES.some((p) => line.includes(p)))
        .filter((line) => !serverClaims.some((c) => line.includes(c.text)))
        .map((line) => line.trim());

      expect(unregistered).toEqual([]);
    });
  }

  // The two false ones, retired from every surface that could carry them again.
  const retiredClaims = [
    "once the subject's newest has been deleted",
    'sequences the server no longer has',
    'no sequence check can recognise',
  ];
  for (const surface of claimSurfaces) {
    for (const claim of retiredClaims) {
      it(`${surface.name} no longer claims "${claim}"`, () => {
        expect(surface.text.replace(/\s+/g, ' ')).not.toContain(claim);
      });
    }
  }

  // An absolute claim over a code path that swallows its own failure is a claim the plugin does not
  // keep. The post-ack incarnation read is best-effort by design, so the README states the window
  // that leaves open — and msg-id.test.ts pins the behaviour inside it.
  it('README states the residual window of the post-ack incarnation read instead of denying it', () => {
    expect(readme.toLowerCase()).not.toContain('cannot re-mint');
    expect(readme.replace(/\s+/g, ' ')).toContain(
      'the id carries the last incarnation the plugin observed',
    );
  });

  // The cursor and the backendMsgId are the SAME minted value, so a surface describing them
  // differently is not imprecision — it is a claim about a distinction the minter does not make, and
  // a reader who believes it writes a bare decimal `since` and is served the newest window instead
  // of resuming. Graded on all three published surfaces at once, so a future rename of the shape
  // reddens every surface rather than only the one somebody remembered.
  const minted = (): { cursor: string; id: string; shape: string } => {
    const plugin = new NatsPlugin() as unknown as {
      incarnations: Map<string, string>;
      streamName: (t: Topic) => string;
      msgId: (t: Topic, seq: number) => string;
      cursorAt: (stream: string, seq: number) => string;
    };
    const topic = asTopic('deploys');
    const stream = plugin.streamName(topic);
    plugin.incarnations.set(stream, '20260101T000000Z');
    return {
      cursor: String(plugin.cursorAt(stream, 42)),
      id: plugin.msgId(topic, 42),
      shape: '<stream incarnation>-<sequence>',
    };
  };

  it('mints one value for both the cursor and the backendMsgId', () => {
    const { cursor, id } = minted();
    expect(cursor).toBe('20260101T000000Z-42');
    expect(id).toBe(cursor);
  });

  /**
   * What a surface says a value IS, in the `<something> as the <role>` shape npm prose uses. The
   * noun phrase stops at a conjunction, so a claim about one role cannot swallow the other's.
   */
  const roleClaim = (text: string, role: string): string | undefined =>
    new RegExp(`(?<![-\\w])((?:(?!\\b(?:as|and|or)\\b)[\\w-]+ ){0,6}[\\w-]+) as (?:the )?${role}\\b`, 'i')
      .exec(text)?.[1]
      ?.trim()
      .toLowerCase();

  const shapeSurfaces = [
    { name: 'README.md', text: readme },
    { name: 'the npm description', text: manifest.description },
    { name: 'src/index.ts', text: sources.find((f) => f.name === 'index.ts')?.text ?? '' },
  ];

  for (const surface of shapeSurfaces) {
    it(`${surface.name} names both roles and the incarnation qualification the minter applies`, () => {
      expect(surface.text.toLowerCase()).toContain('incarnation');
      expect(surface.text).toContain('cursor');
      expect(surface.text).toContain('backendMsgId');
    });

    it(`${surface.name} does not describe the cursor and the backendMsgId as different values`, () => {
      const cursorClaim = roleClaim(surface.text, 'cursor');
      const idClaim = roleClaim(surface.text, 'backendMsgId');
      if (cursorClaim === undefined || idClaim === undefined) return;
      expect({ cursorClaim, idClaim }).toEqual({ cursorClaim, idClaim: cursorClaim });
    });
  }

  it('README documents the shape in both mapping rows', () => {
    const { shape } = minted();
    expect(readme.match(new RegExp(`\`${shape}\``, 'g')) ?? []).toHaveLength(2);
  });

  it('the differing-claim check reads a contrast and spares a shared one', () => {
    const drifted =
      'the per-topic stream sequence as the cursor and an incarnation-qualified sequence as the backendMsgId';
    expect(roleClaim(drifted, 'cursor')).toBe('the per-topic stream sequence');
    expect(roleClaim(drifted, 'backendMsgId')).toBe('an incarnation-qualified sequence');
    expect(roleClaim(drifted, 'cursor')).not.toBe(roleClaim(drifted, 'backendMsgId'));

    const shared =
      'an incarnation-qualified sequence as the cursor, and an incarnation-qualified sequence as the backendMsgId';
    expect(roleClaim(shared, 'cursor')).toBe('an incarnation-qualified sequence');
    expect(roleClaim(shared, 'backendMsgId')).toBe(roleClaim(shared, 'cursor'));
  });

  // A stated SYMPTOM is a claim like any other, and the wrong symptom is worse than none: an operator
  // told a prefix mismatch splits history hunts for two halves of a conversation, while the bridge in
  // front of them is refusing every post. The plugin now raises on a partial divergence, so the words
  // that promised silence are retired from every surface that carries them — README and the runnable
  // nats configs alike.
  const exampleDir = fileURLToPath(new URL('../../../examples/multi-session/nats', import.meta.url));
  const exampleConfigs = readdirSync(exampleDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({ name: `examples/multi-session/nats/${f}`, text: readFileSync(join(exampleDir, f), 'utf8') }));

  it('finds the example configs it is meant to police', () => {
    expect(exampleConfigs.length).toBeGreaterThan(2);
  });

  const retiredSymptoms = ['silently maps', 'splitting history with'];
  for (const surface of [{ name: 'README.md', text: readme }, ...exampleConfigs]) {
    for (const claim of retiredSymptoms) {
      it(`${surface.name} no longer says a prefix mismatch "${claim}"`, () => {
        expect(surface.text.toLowerCase()).not.toContain(claim);
      });
    }
  }

  it('README describes the divergence symptom the code produces', () => {
    expect(readme).toContain('naming `subject_prefix`/`stream_prefix`');
  });

  // A `readme.toContain(key)` is satisfied by any prose that happens to hold the word — 'token'
  // matches "NATS subject tokens", 'pass' matches "is passed through" — so most of these rows could
  // not fail on the drift they exist to catch. The field has to be documented WHERE A READER WOULD
  // USE IT: as a key of the fenced `backend_config` block. The list is derived from the exported
  // interface as well, so a new config field is undocumented-by-default rather than unpoliced.
  const configBlock = (text: string): string =>
    /```ya?ml\s*\nbackend_config:\n([\s\S]*?)```/.exec(text)?.[1] ?? '';

  const documentsKey = (block: string, key: string): boolean =>
    new RegExp(`^\\s*${key}:`, 'm').test(block);

  const declaredKeys = [
    ...(/export interface NatsBackendConfig \{([\s\S]*?)\n\}/
      .exec(sources.find((f) => f.name === 'index.ts')?.text ?? '')?.[1] ?? '')
      .matchAll(/^ {2}([a-z_]+)\??:/gm),
  ].map((m) => m[1] as string);

  it('finds the config surface it is meant to police', () => {
    expect(declaredKeys).toContain('nkey_seed');
    expect(declaredKeys.length).toBeGreaterThan(6);
    expect(configBlock(readme)).toContain('servers:');
  });

  for (const key of declaredKeys) {
    it(`the README's backend_config block documents \`${key}\``, () => {
      expect(documentsKey(configBlock(readme), key)).toBe(true);
    });
  }

  it('the config-block check reads the block, not the prose around it', () => {
    const stripped = readme.replace(/```ya?ml\s*\nbackend_config:\n[\s\S]*?```/, '');
    for (const key of declaredKeys) {
      expect(documentsKey(configBlock(stripped), key), key).toBe(false);
    }
    expect(documentsKey('  token: "…"', 'token')).toBe(true);
    expect(documentsKey('a token is passed through', 'token')).toBe(false);
  });
});
