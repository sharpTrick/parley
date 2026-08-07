import { DEFAULT_DEADLINE_MS, plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import { aliasOf, LEGAL_LOCALPART, MAX_ALIAS_BYTES } from './alias.js';
import { TOPIC_KEY } from './wire.js';

/** Every `preset` a config may ask for. Each member is graded and documented in the README table. */
export const ROOM_PRESETS = ['private_chat', 'public_chat'] as const;
export type RoomPreset = (typeof ROOM_PRESETS)[number];

export interface MatrixBackendConfig {
  /**
   * Homeserver base URL. Default `http://127.0.0.1:8008`. `http://` to anything but loopback ships
   * {@link password} and the access token it returns across the network in the clear, and
   * `connect()` warns about it; use `https://` for a remote homeserver.
   */
  homeserver_url?: string;
  /** Login user localpart. Default `parley`. */
  user?: string;
  /** Login password. Default `parleypass`. */
  password?: string;
  /** Homeserver `server_name` used to build room aliases. Default `parley.local`. */
  server_name?: string;
  /**
   * Sync long-poll timeout (ms) — a positive whole number, at most {@link MAX_SYNC_TIMEOUT_MS}. The
   * loop re-checks shutdown each interval. Default 25000.
   */
  sync_timeout_ms?: number;
  /**
   * OPTIONAL shared-room mode (test fixtures / rate-limited deployments). When set to an alias
   * localpart, EVERY topic maps to this one room instead of `#parley_<topic>`, and topics are
   * isolated by a `app.parley.topic` tag carried on each event (filtered on read and on the live
   * path). Synapse rate-limits *room creation* hard (~2-room burst, then ~1 room / 45s per user),
   * while message send/read/sync are unthrottled — so a one-room-per-topic suite is infeasible for
   * an unprivileged login. A production deployment runs the bridge as a rate-limit-exempt
   * appservice and leaves this UNSET to get a real Matrix room per topic. See README.
   *
   * SECURITY: the `app.parley.topic` tag is UNTRUSTED, member-writable event content with no
   * server-enforced integrity — any member of the shared room can send a message whose tag names an
   * arbitrary topic (including the reserved presence topic, entering `computeRoster` under its own
   * homeserver-stamped sender). So in `shared_room` mode inbound data chooses which topic/allowlist
   * bucket a message lands in. This mode is for TEST FIXTURES / rate-limited deployments ONLY and
   * MUST NOT carry mutually-distrusting topics. Production leaves this UNSET: one physically separate
   * Matrix room per topic, where the tag is ignored (rooms are the isolation boundary).
   */
  shared_room?: string;
  /**
   * `preset` for rooms this plugin CREATES. Default `private_chat` → `join_rule: invite`, so a
   * guessable alias (`#parley_<topic>:<server_name>`) does not let an uninvited account on the
   * homeserver (or, under federation, anywhere) read the topic's history or inject `<channel>`
   * events into a live agent session. Set `public_chat` only for a deliberately human-joinable
   * room; peers you want in an invite-only room go in {@link invite}. Matrix's third preset,
   * `trusted_private_chat`, is refused — {@link validateConfig} says why.
   */
  room_preset?: RoomPreset;
  /** MXIDs invited to rooms this plugin creates (an invite-only room admits nobody else). */
  invite?: string[];
}

export const DEFAULT_HOMESERVER_URL = 'http://127.0.0.1:8008';

/** `server_name` every alias is built for when the config names none. */
export const DEFAULT_SERVER_NAME = 'parley.local';

/** Repo-public login password every dev fixture ships with; never a secret. */
export const DEFAULT_PASSWORD = 'parleypass';

/** Largest delay Node's timers accept; past it every one of them silently becomes 1ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Largest accepted `sync_timeout_ms`: the one this plugin can still arm a real transport deadline
 * for, since every `/sync` is bounded by {@link syncDeadlineMs} of it.
 */
export const MAX_SYNC_TIMEOUT_MS = MAX_TIMER_MS - DEFAULT_DEADLINE_MS;

/**
 * Wall-clock budget for a `/sync` that asks the homeserver to block for `timeoutMs`. A long-poll
 * legitimately outlives the shared {@link DEFAULT_DEADLINE_MS}, so every `/sync` call MUST pass
 * this — at the default budget any `sync_timeout_ms` at or above 30000 aborts client-side before a
 * conforming homeserver has answered, and the live path degrades to the retry backoff instead.
 * Bounded above by {@link MAX_SYNC_TIMEOUT_MS}, which {@link validateConfig} enforces so the result
 * always fits a Node timer.
 */
export const syncDeadlineMs = (timeoutMs: number): number => timeoutMs + DEFAULT_DEADLINE_MS;

const isHttpUrl = (s: string): boolean => {
  try {
    const { protocol } = new URL(s);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Core loads `backend_config` as `z.record(z.unknown())`, so each knob below arrives unchecked and
 * goes straight onto the `POST /createRoom` wire or into the park arithmetic. Keep this a LOAD
 * ERROR rather than a coercion or a warning, so that an unsupported privilege or timing knob fails
 * the way `skip_permissions: true` does instead of taking effect in a shape nothing expects.
 */
export function validateConfig(cfg: MatrixBackendConfig): void {
  const reject = (key: keyof MatrixBackendConfig, expected: string, why = ''): never => {
    const raw = cfg[key];
    throw new Error(
      `[parley-matrix] backend_config.${key} = ` +
        `${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)} is not accepted: ` +
        `expected ${expected}.${why}`,
    );
  };
  for (const key of ['homeserver_url', 'user', 'password', 'server_name', 'shared_room'] as const) {
    const v = cfg[key];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      reject(key, 'a non-empty string');
    }
  }
  if (cfg.homeserver_url !== undefined && !isHttpUrl(cfg.homeserver_url)) {
    reject('homeserver_url', 'an http(s) URL');
  }
  // The derived path folds a topic through `sanitizeAlias` and bounds it with `boundedLocalpart`;
  // an operator-supplied localpart is used VERBATIM, so it must clear both here or the deployment
  // addresses a room name the homeserver reads as something else — or refuses outright.
  const shared = cfg.shared_room;
  if (shared !== undefined) {
    const alias = aliasOf(shared, cfg.server_name ?? DEFAULT_SERVER_NAME);
    if (!LEGAL_LOCALPART.test(shared) || Buffer.byteLength(alias, 'utf8') > MAX_ALIAS_BYTES) {
      reject(
        'shared_room',
        `a room alias localpart of ${LEGAL_LOCALPART.source} whose alias ` +
          `#<shared_room>:<server_name> fits ${MAX_ALIAS_BYTES} bytes`,
        ` It is used verbatim: ${JSON.stringify(alias)} is ${Buffer.byteLength(alias, 'utf8')} ` +
          'bytes, and Matrix splits an alias on its FIRST colon — so a localpart carrying one ' +
          'names a different server than backend_config.server_name, and an over-long one is ' +
          'refused by createRoom while every read of it returns the empty page an unwritten topic ' +
          'returns.',
      );
    }
  }
  const timeout = cfg.sync_timeout_ms;
  if (
    timeout !== undefined &&
    !(Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_SYNC_TIMEOUT_MS)
  ) {
    reject(
      'sync_timeout_ms',
      `a positive whole number of milliseconds, at most ${MAX_SYNC_TIMEOUT_MS} (default 25000)`,
      ` The ceiling is Node's ${MAX_TIMER_MS}ms timer range less the ${DEFAULT_DEADLINE_MS}ms call ` +
        'budget every /sync adds on top of it: past it the transport deadline clamps to 1ms, so ' +
        'every /sync aborts client-side at once and the live path dies blaming the homeserver.',
    );
  }
  const invite = cfg.invite;
  if (
    invite !== undefined &&
    (!Array.isArray(invite) || invite.some((m) => typeof m !== 'string' || m.length === 0))
  ) {
    reject('invite', 'an array of non-empty MXID strings');
  }
  if (
    cfg.room_preset !== undefined &&
    !(ROOM_PRESETS as readonly string[]).includes(cfg.room_preset)
  ) {
    reject(
      'room_preset',
      `one of ${ROOM_PRESETS.join(', ')}`,
      " Matrix's `trusted_private_chat` is refused deliberately: it hands every invitee power " +
        'level 100, so any of them can flip m.room.join_rules to public and defeat the invite-only ' +
        'guarantee the default preset exists for.',
    );
  }
}

/**
 * Every config shape that widens this backend's trust boundary, phrased for the operator's stderr.
 * A risk documented only in the README is one an operator who copied a fixture config never sees.
 * A warning rather than a load error, because each is legitimate for a rate-limited deployment.
 */
export function configRisks(cfg: MatrixBackendConfig): string[] {
  const risks: string[] = [];
  const plaintext = plaintextRemoteOrigin(cfg.homeserver_url ?? DEFAULT_HOMESERVER_URL);
  if (plaintext !== undefined) {
    risks.push(
      `backend_config.homeserver_url ${plaintext} is plaintext http:// to a non-loopback host, so ` +
        'the m.login.password POST carries backend_config.password across the network in the ' +
        'clear, and the access token it returns rides every later request the same way. Use ' +
        'https:// for any remote homeserver.',
    );
  }
  if (cfg.password === undefined || cfg.password === DEFAULT_PASSWORD) {
    risks.push(
      `connecting with the built-in default password ('${DEFAULT_PASSWORD}'). Set ` +
        'backend_config.password to a real secret; a network-reachable homeserver provisioned ' +
        'with this password is world-readable/injectable.',
    );
  }
  if (cfg.shared_room !== undefined) {
    risks.push(
      `backend_config.shared_room (${JSON.stringify(cfg.shared_room)}) folds EVERY topic into one ` +
        `Matrix room, isolated only by the member-forgeable '${TOPIC_KEY}' event tag: any member ` +
        'of that room can post a message tagged with any other topic, including the presence ' +
        'topic. Leave shared_room unset in production so each topic gets its own room.',
    );
  }
  if (cfg.room_preset === 'public_chat') {
    risks.push(
      "backend_config.room_preset 'public_chat' makes every room this bridge creates joinable by " +
        'any account on the homeserver (and, under federation, beyond) via its guessable alias — ' +
        "which admits readers of the topic's history and injectors of live agent events. Use the " +
        "default 'private_chat' with backend_config.invite unless the room is deliberately open.",
    );
  }
  return risks;
}
