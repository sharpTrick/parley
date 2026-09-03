// Barrel-surface regression guard.
//
// The public entry `@sharptrick/parley-core` is automated-semver surface: a merge to `main` is a
// lockstep release, so a symbol that reaches the barrel is published and cannot be withdrawn
// without a major. A sample of kept names cannot see a WIDENING — a new export is on neither the
// kept list nor the trimmed one — so the surface is pinned WHOLE, by value, in both directions.
//
// It is a test only — it does not re-export anything from the barrel.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

const BARREL_PATH = fileURLToPath(new URL('./index.ts', import.meta.url));
const BARREL = readFileSync(BARREL_PATH, 'utf8');

const SRC = readdirSync(fileURLToPath(new URL('.', import.meta.url)), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'));

describe('public barrel surface', () => {
  // The consumer-free internals kept out of the barrel. These stay defined in their own
  // modules (config.ts, regex-safety.ts, engine/seen-set.ts, transport/) for in-package callers,
  // reached via relative imports — but must never be reachable through the public entry.
  const trimmed = [
    'MAX_TOPICS',
    'MAX_POST_TOPICS',
    'MAX_FETCH_LIMIT',
    'SEEN_MAX_PER_TOPIC',
    'isRedosSafeSource',
    'describeAllowed',
    'topicSchema',
  ] as const;

  // The WHOLE published surface, by value. A sample list is blind in the direction that actually
  // ships: a symbol added to the barrel is on neither the kept list nor the trimmed one, so it
  // reaches npm unnoticed. Types are counted too — `Object.keys` sees no type-only re-export.
  const SURFACE = [
    'Allowlist', 'AllowlistOptions', 'AuthConfig', 'AuthSchema', 'BackendCliOptions',
    'BackendConfig', 'BackendConfigKeys', 'BackendIdentity', 'BackendMsgId', 'BackendPlugin',
    'BlockingFetchOptions', 'BuildMessageInput', 'CHANNEL_NOTIFICATION_METHOD', 'CORE_VERSION',
    'CatchUpArgs', 'ConfigSchema', 'ConsentError', 'Cursor', 'DEFAULT_HASH_LEN', 'FakeOidc',
    'FakeOidcClaims', 'FetchAbortedError', 'FetchRecentArgs', 'FetchRecentResult', 'Handle',
    'MAX_BLOCK_MS', 'MAX_HASH_LEN', 'MAX_MATCH_INPUT', 'MIN_HASH_LEN', 'Message',
    'MessageHandler', 'NoSuchTopicError', 'OAuthRemoteOptions', 'OAuthRemoteServer',
    'OidcAuthConfig', 'OidcAuthSchema', 'OidcRemoteOptions', 'OidcRemoteServer',
    'OidcTokenVerifier', 'OidcVerifierOptions', 'ParleyBridge', 'ParleyConfig',
    'ParleyOAuthProvider', 'ParleyOAuthProviderOptions', 'ParseArgsOptions', 'ParsedArgs',
    'PushLoopOptions', 'ReadStateStore', 'RemoteAuthOptions', 'RemoteAuthServer',
    'RemoteHttpOptions', 'RemoteHttpServer', 'SeenSet', 'ShutdownHost', 'TOOL_TEXT', 'ToolDeps',
    'Topic', 'TopicNotAllowedError', 'UnsafePatternError', 'allowlistFor', 'asBackendMsgId',
    'asCursor', 'asHandle', 'asTopic', 'assertKnownConfigKeys', 'buildBridge', 'buildMessage',
    'buildReactiveServer', 'catchUpAll', 'catchUpTopic', 'channelMeta', 'createOAuthRemoteApp',
    'createOidcRemoteApp', 'createRemoteAuthApp', 'createRemoteHttpApp', 'createStdioBridge',
    'defaultReadStatePath', 'emitChannel', 'fetchOidcDiscovery', 'fetchRecentBlocking',
    'hashOwnerSecret', 'installShutdown', 'instanceIdOf', 'isFetchAbortedError',
    'isNoSuchTopicError', 'loadConfig', 'makeOwnerVerifier', 'ownerVerifierFromPassphrase',
    'parseArgs', 'parseConfig', 'parseMentions', 'registerTools', 'runBackendCli', 'safeName',
    'startFakeOidc', 'startPushLoop', 'toolDepsFor', 'usageFor',
  ] as const;

  it.each(trimmed)('still defines the trimmed internal %s somewhere in src', (name) => {
    expect(
      SRC.some((text) => new RegExp(`\\b(?:function|const|class|interface|type)\\s+${name}\\b`).test(text)),
      `${name} is asserted absent from the barrel but no longer exists in src — a row that grades ` +
        'nothing while reading as coverage. Delete it, or fix the name it drifted from.',
    ).toBe(true);
  });

  // Runtime bindings plus the barrel's own type-only export clauses: a `.d.ts` name is semver
  // surface with no runtime key to enumerate.
  const published = (): string[] => {
    const names = new Set<string>(Object.keys(api));
    for (const clause of BARREL.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
      for (const spec of clause[1]!.split(',')) {
        const name = spec.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    return [...names].sort();
  };

  it('publishes exactly this surface, and nothing more', () => {
    expect(published()).toEqual([...SURFACE]);
  });

  // The scan above reads export CLAUSES, so a star re-export widens the surface past everything it
  // can see: two exported types plus `export * from './x.js'` leave the pin above at full strength
  // and full ignorance. Named clauses only is what makes that scan complete by construction.
  it('re-exports through named clauses only, so the pin above can see the whole surface', () => {
    expect(BARREL.match(/^\s*export\s+(?:type\s+)?\*/gm) ?? []).toEqual([]);
  });

  /**
   * The names above are the surface a consumer can IMPORT; the members of those names are the
   * surface a consumer can CALL, and dropping one is a break the name pin cannot see —
   * `AllowlistOptions.reserved` was removed with nothing red, and `SeenSet` grew a public method
   * with nothing red. Take the members off the compiler's own view of the barrel, resolving each
   * re-export to the declaration it lands on, so a type that moves file stays graded and a member
   * restated in a doc cannot stand in for the member itself.
   *
   * A class's non-public members are not that surface, so they are not pinned: `private` and
   * `protected` are withdrawable without a major, and a `#name` is not even nameable.
   */
  const PUBLIC_MODIFIERS = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;

  type Members = readonly ts.ClassElement[] | readonly ts.TypeElement[];

  const callableMembers = (decl: ts.Declaration): Members | undefined => {
    if (ts.isInterfaceDeclaration(decl)) return decl.members;
    if (ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type)) return decl.type.members;
    if (ts.isClassDeclaration(decl))
      return decl.members.filter(
        (m) =>
          (ts.getCombinedModifierFlags(m) & PUBLIC_MODIFIERS) === 0 &&
          !(m.name !== undefined && ts.isPrivateIdentifier(m.name)) &&
          !ts.isClassStaticBlockDeclaration(m) &&
          !ts.isSemicolonClassElement(m),
      );
    return undefined;
  };

  const memberName = (m: ts.ClassElement | ts.TypeElement): string =>
    ts.isConstructorDeclaration(m) ? 'constructor' : (m.name?.getText() ?? '[index signature]');

  const memberShapes = (): Record<string, string[]> => {
    const program = ts.createProgram([BARREL_PATH], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(BARREL_PATH)!;
    const shapes: Record<string, string[]> = {};
    for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)) {
      const target =
        (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
      for (const decl of target.declarations ?? []) {
        const members = callableMembers(decl);
        if (members === undefined) continue;
        shapes[symbol.name] = [
          ...new Set([...(shapes[symbol.name] ?? []), ...members.map(memberName)]),
        ].sort();
      }
    }
    return shapes;
  };

  const MEMBERS: Record<string, string[]> = {
    Allowlist: ['assert', 'constructor', 'has', 'patterns', 'topics'],
    AllowlistOptions: ['postPatterns'],
    BackendCliOptions: ['bin', 'moduleUrl', 'plugin'],
    BackendConfig: ['[index signature]'],
    BackendConfigKeys: ['keys', 'nested'],
    BackendIdentity: ['backendRef', 'handle'],
    BackendPlugin: ['connect', 'disconnect', 'fetchRecent', 'post', 'resolveIdentity', 'subscribe'],
    BlockingFetchOptions: ['blockMs', 'now', 'pollIntervalMs', 'signal', 'sleep'],
    BuildMessageInput: ['content', 'cursor', 'id', 'sender', 'timestamp', 'topic'],
    CatchUpArgs: ['limit', 'plugin', 'readState', 'seen', 'topic'],
    ConsentError: ['constructor'],
    FakeOidc: ['close', 'issuer', 'jwksUri', 'mint'],
    FakeOidcClaims: [
      'aud', 'azp', 'expiresInS', 'issuerOverride', 'notBeforeInS', 'omit', 'preferred_username',
      'realm_access', 'scope', 'signWithRogueKey', 'sub',
    ],
    FetchAbortedError: ['constructor'],
    FetchRecentArgs: ['blockMs', 'limit', 'since', 'topic'],
    FetchRecentResult: ['messages', 'nextCursor'],
    Message: ['backendMsgId', 'content', 'cursor', 'mentions', 'senderHandle', 'timestamp', 'topic'],
    NoSuchTopicError: ['constructor'],
    OAuthRemoteOptions: [
      'issuerUrl', 'mcpPath', 'now', 'scopesSupported', 'trustProxy', 'verifyOwner',
    ],
    OAuthRemoteServer: ['provider', 'resource'],
    OidcRemoteOptions: ['fetchFn', 'mcpPath', 'now', 'oidc', 'publicUrl'],
    OidcRemoteServer: ['authorizationServer', 'resource', 'verifier'],
    OidcTokenVerifier: ['constructor', 'verifyAccessToken'],
    OidcVerifierOptions: [
      'allowedSubjects', 'allowedUsernames', 'audience', 'clockSkewS', 'issuer', 'jwksUri', 'now',
      'requiredRole', 'requiredScope',
    ],
    ParleyBridge: ['attach', 'server', 'shutdown'],
    ParleyOAuthProvider: [
      'authorize', 'challengeForAuthorizationCode', 'clientsStore', 'completeConsent',
      'constructor', 'exchangeAuthorizationCode', 'exchangeRefreshToken', 'revokeToken', 'stop',
      'verifyAccessToken',
    ],
    ParleyOAuthProviderOptions: ['consentPath', 'now', 'resource', 'scopesSupported', 'verifyOwner'],
    ParseArgsOptions: ['bin', 'env', 'version'],
    PushLoopOptions: ['identity', 'mentionFilter'],
    ReadStateStore: ['constructor', 'get', 'path', 'set'],
    RemoteAuthOptions: [
      'fetchFn', 'mcpPath', 'now', 'publicUrl', 'scopesSupported', 'trustProxy', 'verifyOwner',
    ],
    RemoteHttpOptions: ['allowedHosts', 'configureApp', 'insecureNoAuth', 'mcpPath', 'protect'],
    RemoteHttpServer: ['app', 'close', 'listen'],
    SeenSet: ['constructor', 'firstSeen', 'has', 'markSeen'],
    ShutdownHost: ['on', 'stdin'],
    ToolDeps: ['allow', 'blockMaxMs', 'blockPollIntervalMs', 'identity', 'plugin', 'seen'],
    TopicNotAllowedError: ['constructor'],
    UnsafePatternError: ['constructor'],
  };

  it('publishes exactly these members on the types it exports, and no others', () => {
    const shapes = memberShapes();
    expect(Object.keys(shapes).every((name) => (SURFACE as readonly string[]).includes(name))).toBe(
      true,
    );
    expect(shapes).toEqual(MEMBERS);
  });
});

// A doc comment on a barrel-exported symbol ships verbatim in `dist/*.d.ts` and is the only
// specification an out-of-tree plugin author reads. When it says "outside {@link MIN_HASH_LEN}…{@link
// MAX_HASH_LEN}" and only the floor is exported, that author can name the floor and must hardcode
// the ceiling — the doc promises a surface the package does not have. Pinning the one symbol by name
// would guard the instance; derive the offenders instead, so the next helper documented against an
// unexported constant is caught by the same case.
describe('shipped JSDoc never links a value the barrel withholds', () => {
  const SRC = fileURLToPath(new URL('./', import.meta.url));

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (extname(full) === '.ts' && !full.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  const EXPORT_DECL =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|function|async function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
  const VALUE_DECL = /^export\s+(?:const|function|async function|class)\s+([A-Za-z_$][\w$]*)/;
  const TOP_DECL =
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|function|async function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

  // Type-only re-exports are part of the shipped surface but carry no runtime binding, so read the
  // barrel's own export clauses rather than only `Object.keys(api)`.
  const exposed = new Set<string>(Object.keys(api));
  for (const clause of BARREL.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const spec of clause[1]!.split(',')) {
      const name = spec.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) exposed.add(name);
    }

  const STRINGS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

  interface DocBlock {
    /** The declaration a reader sees this doc ON: itself at depth 0, its enclosing one below. */
    owner: string | null;
    depth: number;
    doc: string;
  }

  interface Scan {
    blocks: DocBlock[];
    /** Names declared `export` at depth 0 — what makes a file part of the shipped surface. */
    exported: string[];
    /** Exported names with a runtime binding — the ones a `{@link}` could have been importable. */
    values: string[];
    /** Whether the brace walk returned to depth 0, i.e. whether the depths above mean anything. */
    balanced: boolean;
  }

  /**
   * Walk one source, attributing each doc block to the declaration it documents AT ANY DEPTH. A
   * doc on an interface member, an object-literal (zod schema) field or a class method ships into
   * `.d.ts` verbatim, exactly as a top-level one does; a scanner that attaches a block only to the
   * next line when that line is itself an `export` reads the top-level position and nothing else,
   * which is how `AllowlistOptions.postPatterns` came to link a constant the barrel withholds.
   */
  function scan(source: string): Scan {
    const blocks: DocBlock[] = [];
    const exported: string[] = [];
    const values: string[] = [];
    let block: string[] | null = null;
    let depth = 0;
    let top: string | null = null;
    for (const raw of source.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('/**')) block = [line];
      else if (block && (line.startsWith('*') || line.startsWith('*/'))) block.push(line);
      else {
        const declared = TOP_DECL.exec(line)?.[1];
        if (depth === 0 && declared !== undefined) {
          top = declared;
          if (EXPORT_DECL.test(line)) exported.push(declared);
          if (VALUE_DECL.test(line)) values.push(declared);
        }
        if (block) blocks.push({ owner: depth === 0 ? declared ?? null : top, depth, doc: block.join('\n') });
        block = null;
        const code = line.replace(STRINGS, '').replace(/\/\/.*$/, '');
        for (const ch of code) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      }
    }
    return { blocks, exported, values, balanced: depth === 0 };
  }

  const files = sources(SRC);
  const scans = files.map((file) => [file.slice(SRC.length), scan(readFileSync(file, 'utf8'))] as const);
  const values = new Set<string>(scans.flatMap(([, s]) => s.values));

  /**
   * Which of a file's doc blocks a consumer can actually read. A top-level one ships when the
   * barrel names it; a NESTED one ships whenever the file contributes any public surface at all,
   * because the enclosing declaration need not be exported itself for its member docs to be
   * emitted — `config.ts`'s `ConfigObject` is private and its field docs land in `ConfigSchema`'s
   * shipped type.
   */
  function shippedBlocks(scan: Scan, importable: ReadonlySet<string>): DocBlock[] {
    const contributes = scan.exported.some((name) => importable.has(name));
    return scan.blocks.filter((b) =>
      b.depth === 0 ? b.owner !== null && importable.has(b.owner) : contributes,
    );
  }

  /**
   * Every adorned spelling a doc block can name a symbol in. This guard was written about
   * `AllowlistOptions.postPatterns` naming the post-pattern cap, in `{@link}` form; the reference
   * was later reworded to backticks and walked straight past a matcher scoped to the one syntax.
   * A spelling is a ROW, so the next rewording is a missing row rather than a silent hole.
   *
   * Unadorned prose is deliberately not a spelling. Matched as a bare word, `parse` in
   * backend-cli.ts's prose and `harness` in stdio-bridge.ts's collide with minted names and read as
   * offenders — a reference is what renders as a link or a code span, and stating the VALUE in
   * prose is the sanctioned fix for a cap the barrel withholds.
   */
  const REFERENCE_SPELLINGS: readonly (readonly [
    label: string,
    render: (name: string) => string,
    find: RegExp,
  ])[] = [
    ['{@link X}', (n) => `{@link ${n}}`, /\{@link\s+([A-Za-z_$][\w$]*)/g],
    ['{@linkcode X}', (n) => `{@linkcode ${n}}`, /\{@linkcode\s+([A-Za-z_$][\w$]*)/g],
    ['{@linkplain X}', (n) => `{@linkplain ${n}}`, /\{@linkplain\s+([A-Za-z_$][\w$]*)/g],
    ['a backticked identifier', (n) => `\`${n}\``, /`([A-Za-z_$][\w$]*)`/g],
    ['a bracketed identifier', (n) => `[${n}]`, /\[([A-Za-z_$][\w$]*)\]/g],
  ];

  function referenced(doc: string): string[] {
    return [
      ...new Set(
        REFERENCE_SPELLINGS.flatMap(([, , find]) => [...doc.matchAll(find)].map((m) => m[1]!)),
      ),
    ];
  }

  function linkOffenders(scan: Scan, importable: ReadonlySet<string>, minted: ReadonlySet<string>): string[] {
    return shippedBlocks(scan, importable).flatMap((b) =>
      referenced(b.doc)
        .filter((name) => minted.has(name) && !importable.has(name))
        .map((name) => `${b.owner ?? '<file>'}'s doc names ${name}, which index.ts does not export`),
    );
  }

  const documented = scans.flatMap(([file, s]) => shippedBlocks(s, exposed).map((b) => ({ file, ...b })));

  it('finds documented exports and exported values to check (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(documented.length).toBeGreaterThan(20);
    expect(values.size).toBeGreaterThan(20);
    expect(values.has('safeName')).toBe(true);
    expect(scans.filter(([, s]) => !s.balanced).map(([file]) => file)).toEqual([]);
    // A scanner that reads only the top-level position satisfies every count above.
    expect(documented.filter((d) => d.depth > 0).length).toBeGreaterThan(20);
  });

  /**
   * Grade the scanner by doc POSITION, not by how many blocks it happens to find. Each row is a
   * source carrying one `{@link Withheld}` somewhere a `.d.ts` would carry it verbatim, and the
   * scanner has to name the owner a consumer reads it on and report it. A position missing from
   * this table is a position that can ship unread.
   */
  const PUBLIC = new Set(['Owner', 'Shipped']);
  const MINTED = new Set(['Withheld']);
  const POSITIONS: readonly (readonly [label: string, owner: string, source: string])[] = [
    ['a top-level export', 'Owner', '/** see {@link Withheld} */\nexport const Owner = 1;\n'],
    ['a one-line doc', 'Owner', '/** {@link Withheld} */\nexport const Owner = 1;\n'],
    [
      'an interface member',
      'Owner',
      'export interface Owner {\n  /** see {@link Withheld} */\n  field?: string;\n}\n',
    ],
    [
      'an object-literal member of a private const the barrel ships the type of',
      'Private',
      'export const Shipped = 1;\nconst Private = z.object({\n  /** see {@link Withheld} */\n  field: z.string(),\n});\n',
    ],
    [
      'a class method',
      'Owner',
      'export class Owner {\n  /** see {@link Withheld} */\n  method(): void {}\n}\n',
    ],
    [
      'a member nested two deep',
      'Owner',
      'export interface Owner {\n  nested: {\n    /** see {@link Withheld} */\n    field?: string;\n  };\n}\n',
    ],
    [
      'a member below a field whose default value carries braces',
      'Owner',
      'export interface Owner {\n  first?: Record<string, string>;\n  /** see {@link Withheld} */\n  second?: string;\n}\n',
    ],
  ];

  it.each(POSITIONS)('attributes %s to its owner and reports it', (_label, owner, source) => {
    const scanned = scan(source);
    expect(scanned.balanced).toBe(true);
    expect(scanned.blocks.filter((b) => b.doc.includes('Withheld')).map((b) => b.owner)).toEqual([owner]);
    expect(linkOffenders(scanned, PUBLIC, MINTED)).toHaveLength(1);
  });

  /**
   * Grade the MATCHER the way the positions above grade the walk: one synthetic source per
   * spelling, each required to reach both verdicts. A widened selector nobody has watched fail is
   * the same rule this finding was about, one syntax further out.
   */
  it.each(REFERENCE_SPELLINGS)('reads a reference written as %s', (_label, render) => {
    const source = `/** see ${render('Withheld')} */\nexport const Owner = 1;\n`;
    expect(linkOffenders(scan(source), PUBLIC, MINTED)).toHaveLength(1);
  });

  it.each(REFERENCE_SPELLINGS)('does not fault %s naming a symbol the barrel ships', (_label, render) => {
    const source = `/** see ${render('Shipped')} */\nexport const Owner = 1;\n`;
    expect(linkOffenders(scan(source), PUBLIC, MINTED)).toEqual([]);
  });

  it('does not read an unadorned prose mention as a reference', () => {
    const source = '/** capped at 64 entries; Withheld bounds it internally */\nexport const Owner = 1;\n';
    expect(linkOffenders(scan(source), PUBLIC, MINTED)).toEqual([]);
  });

  it('leaves a link alone when the symbol is importable, or the doc never ships', () => {
    expect(linkOffenders(scan('/** {@link Shipped} */\nexport const Owner = 1;\n'), PUBLIC, MINTED)).toEqual([]);
    expect(
      linkOffenders(scan('/** {@link Withheld} */\nexport const Private = 1;\n'), PUBLIC, MINTED),
    ).toEqual([]);
  });

  it('resolves every reference in a public doc comment to a public symbol', () => {
    const offenders = scans.flatMap(([file, s]) =>
      linkOffenders(s, exposed, values).map((row) => `${file}: ${row}`),
    );
    expect(
      offenders,
      'export the named symbol, or state its VALUE in prose — a consumer cannot import a name the barrel withholds',
    ).toEqual([]);
  });

  /**
   * The same closure one step further out: a shipped type whose only sanctioned constructor is
   * withheld. An out-of-tree composition root handed `registerTools` and `ToolDeps` but not
   * `toolDepsFor` has to hand-assemble the dependency bag, so the next required field breaks every
   * external root at compile time — precisely the lockstep edit the factory exists to prevent, and
   * core's own roots are immune to it. Derive the pairs rather than naming them: a function whose
   * declared return type IS an exported type is that type's constructor, and it ships or the type
   * does not.
   */
  // Both shapes the package writes a function in: a declaration, and a `const` arrow (which is how
  // every brand constructor is written) — a scanner that saw only one would call a type orphaned
  // because it could not see the builder that ships.
  const FN_STARTS = [
    /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g,
    /(?:^|\n)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:<[^<>()]*>)?\(/g,
  ];

  interface Declared {
    name: string;
    params: string;
    returns: string;
  }

  /** Every declared function's name, its parameter text, and its declared return type. */
  function declaredFunctions(src: string): Declared[] {
    const out: Declared[] = [];
    for (const start of FN_STARTS) {
      for (const m of src.matchAll(start)) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let i = open;
        do {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') depth--;
          i++;
        } while (depth > 0 && i < src.length);
        const tail = /^\s*:\s*([^{;=]+?)\s*(?:\{|=>)/.exec(src.slice(i));
        if (tail) {
          out.push({
            name: m[1]!,
            params: src.slice(open + 1, i - 1),
            returns: tail[1]!.trim(),
          });
        }
      }
    }
    return out;
  }

  const functions = files.flatMap((f) =>
    declaredFunctions(readFileSync(f, 'utf8')).map((fn) => ({ ...fn, file: f.slice(SRC.length) })),
  );

  it.each([
    ['a plain declaration', 'export function f(a: number): Thing {', 'Thing'],
    ['a multi-line signature', 'export function f(\n  a: number,\n  b: string,\n): Thing {', 'Thing'],
    ['a parameter that is itself a function', 'function f(p: (t: string) => boolean): Thing {', 'Thing'],
    ['a generic signature', 'function f<T>(p: T): Thing {', 'Thing'],
    ['a const arrow', 'export const f = (s: string): Thing => s as Thing;', 'Thing'],
  ])('the signature scanner reads %s', (_label, src, expected) => {
    expect(declaredFunctions(src).map((fn) => fn.returns)).toEqual([expected]);
  });

  it('finds declared functions to check (guards against a broken scan)', () => {
    expect(functions.length).toBeGreaterThan(20);
    const factory = functions.find((fn) => fn.name === 'toolDepsFor');
    expect(factory?.returns).toBe('ToolDeps');
    expect(functions.find((fn) => fn.name === 'registerTools')?.params).toContain('ToolDeps');
  });

  it('exports a constructor for every exported type its exported functions demand', () => {
    // A type is ORPHANED when this package knows how to build it and ships none of those builders.
    // An internal helper that merely happens to produce one is not a constructor: what matters is
    // whether ANY sanctioned way in exists.
    const builders = new Map<string, Declared[]>();
    for (const fn of functions) builders.set(fn.returns, [...(builders.get(fn.returns) ?? []), fn]);
    const orphaned = [...builders]
      .filter(([type, fns]) => exposed.has(type) && !fns.some((fn) => exposed.has(fn.name)))
      .map(([type]) => type);

    const offenders: string[] = [];
    for (const fn of functions) {
      if (!exposed.has(fn.name)) continue;
      for (const type of orphaned) {
        if (new RegExp(`\\b${type}\\b`).test(fn.params))
          offenders.push(`${fn.file}: ${fn.name}() takes ${type}, whose only builder index.ts withholds`);
      }
    }
    expect(
      offenders,
      'export the factory too, or withhold the type — a consumer handed a type it cannot legally build assembles it by hand and breaks on the next field added to it',
    ).toEqual([]);
  });

  /**
   * The mirror of the rule above: a type the barrel ships that no shipped function names at all. It
   * is not merely useless — a consumer who can name a result type but cannot obtain, parse or hand
   * one back reaches into this package's unpublished `src/` to work around it, which `files: ["dist"]`
   * does not even publish. Derive the pairs from the barrel's own `engine/`/`transport/` clauses, so
   * the next type added there without a producer fails here without anyone naming it.
   */
  const ENGINE_CLAUSE = /export\s+\{([^}]*)\}\s+from\s+'(\.\/(?:engine|transport)\/[^']+)'/g;
  const barrelTypes = [...BARREL.matchAll(ENGINE_CLAUSE)].flatMap(([, clause, module]) =>
    clause!
      .split(',')
      .map((spec) => spec.trim())
      .filter((spec) => spec.startsWith('type '))
      .map((spec) => ({
        module: module!,
        name: spec.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim(),
      })),
  );

  it('finds re-exported engine/transport types to check (guards against a broken scan)', () => {
    expect(barrelTypes.length).toBeGreaterThan(5);
    expect(barrelTypes.map((t) => t.name)).toContain('CatchUpArgs'); // an inline `type` specifier
    expect(barrelTypes.map((t) => t.name)).toContain('ToolDeps'); // a multi-line clause
  });

  it('names every engine/transport type it exports in a function it also exports', () => {
    const shipped = functions.filter((fn) => exposed.has(fn.name));
    const offenders = barrelTypes
      .filter(
        ({ name }) =>
          !shipped.some((fn) => new RegExp(`\\b${name}\\b`).test(`${fn.params} ${fn.returns}`)),
      )
      .map(({ name, module }) => `${name} (from ${module}) is exported with no exported producer or consumer`);
    expect(
      offenders,
      'withhold the type, or export the function that produces or consumes it — a type with no reachable API sends consumers into this package’s unpublished src/',
    ).toEqual([]);
  });
});
