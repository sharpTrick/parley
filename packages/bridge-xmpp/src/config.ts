import {
  assertKnownConfigKeys,
  type BackendConfig,
  type BackendConfigKeys,
} from '@sharptrick/parley-core';
import {
  describeConfigValue,
  isLoopbackHost,
  type PlaintextCredentialRisk,
  sanitizeBody,
} from '@sharptrick/parley-net-util';

import { JID_PART_MAX_BYTES } from './jid.js';
import { assertXmlSafe, attributeNormalizedCodepoint, codepointLabel } from './stanzas.js';

/** Plugin-specific backend_config. */
export interface XmppBackendConfig {
  /** Connection URI. Default `xmpp://127.0.0.1:5222`. */
  service?: string;
  /** XMPP domain (the user's host). Default `parley.local`. */
  domain?: string;
  /** MUC service host — rooms live at `<topic>@<muc_service>`. Default `muc.parley.local`. */
  muc_service?: string;
  /** SASL username. Default `parley`. */
  username?: string;
  /** SASL password. Default `parleypass`. */
  password?: string;
  /**
   * MUC nickname for this connection — the sender every archived message reports. Setting it pins
   * the occupant identity; leaving it unset lets the bridge take its own `identity.handle` (the
   * first `post`'s argument) as the nick, which keeps the sender stable across restarts.
   */
  nick?: string;
  /** RSM page size for MAM catch-up paging. Default 200. */
  mam_page?: number;
}

/**
 * Every name `backend_config` declares. Keep the `satisfies` on it, so that a key added to
 * {@link XmppBackendConfig} without being listed here is a compile error rather than a key
 * `connect()` rejects.
 */
const DECLARED: BackendConfigKeys = {
  keys: Object.keys({
    service: 0,
    domain: 0,
    muc_service: 0,
    username: 0,
    password: 0,
    nick: 0,
    mam_page: 0,
  } satisfies Record<keyof Required<XmppBackendConfig>, 0>),
};
export const CONFIG_KEYS = DECLARED.keys as readonly (keyof XmppBackendConfig)[];
/** Keys that end up as one part of a JID, where a separator would silently build a different JID. */
const JID_PART_KEYS = ['domain', 'muc_service', 'username'] as const;
/** Keys whose value becomes one part of a JID, and so inherits that part's byte ceiling. */
export const JID_SIZED_KEYS = [...JID_PART_KEYS, 'nick'] as const;
const MAX_MAM_PAGE = 10_000;

export const DEFAULT_SERVICE = 'xmpp://127.0.0.1:5222';
export const DEFAULT_PASSWORD = 'parleypass';

/**
 * The only schemes whose stream is encrypted before SASL runs. Keep the classification stated this
 * way round, so that a service form this list does not recognise — `xmpp://`, `ws://`, or the bare
 * DNS-SRV host form carrying no scheme — is treated as unsafe rather than as unknown.
 */
const ENCRYPTED_SCHEMES = ['xmpps:', 'wss:'];
/**
 * Whether `service` may put the SASL password on the network in the clear. `@xmpp/starttls` upgrades
 * only when the peer ADVERTISES the feature and `@xmpp/client` registers SASL PLAIN unconditionally,
 * so an on-path attacker that strips `<starttls/>` from the stream features is handed the credential.
 * A service carrying no scheme is UNKNOWN transport, not safe transport: `@xmpp/resolve` routes it
 * through DNS-SRV, whose candidate list always ends at a cleartext `xmpp://<addr>:5222`.
 *
 * The host is split by hand rather than through `URL`, so that the schemeless DNS-SRV form is
 * classified at all — but the loopback question is `isLoopbackHost`'s, so that this backend and
 * every other one answer it identically.
 */
export function plaintextRemoteHost(service: string): string | undefined {
  const trimmed = service.trim();
  const mark = trimmed.indexOf('://');
  const scheme = mark === -1 ? undefined : trimmed.slice(0, mark + 1).toLowerCase();
  if (scheme !== undefined && ENCRYPTED_SCHEMES.includes(scheme)) return undefined;
  const authority = (mark === -1 ? trimmed : trimmed.slice(mark + 3)).replace(/^\/\//, '');
  const host = (/^([^/?#]*)/.exec(authority)?.[1] ?? '')
    .replace(/^[^@]*@/, '')
    .replace(/^(\[[^\]]*]):\d+$/, '$1')
    .replace(/^\[(.*)]$/, '$1')
    .replace(/^([^:]*):\d+$/, '$1');
  return host !== '' && !isLoopbackHost(host) ? host : undefined;
}

export function isPlaintextRemote(service: string): boolean {
  return plaintextRemoteHost(service) !== undefined;
}

const bad = (key: string, reason: string): Error =>
  new Error(`parley-xmpp: invalid backend_config.${key} — ${reason}`);

/** RFC 3454 table B.1: codepoints both nameprep and resourceprep map to nothing. */
const MAPPED_TO_NOTHING =
  /[\u00AD\u034F\u1806\u180B-\u180D\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]/u;
/** RFC 3454 table C.1.2: non-ASCII spaces, which resourceprep prohibits. */
const NON_ASCII_SPACE = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/u;

const resourceprepFold = (s: string): string => s.normalize('NFKC');
const nameprepFold = (s: string): string =>
  Array.from(s.normalize('NFKC'), (ch) => ch.toLowerCase())
    .join('')
    .normalize('NFKC');

/**
 * The first codepoint of `value` that the server's stringprep profile would rewrite or refuse, or
 * `undefined` if the server keeps it as written. Prefixes are folded rather than single codepoints,
 * so that a mark composing with the letter before it is caught too.
 */
const preppedCodepoint = (
  value: string,
  fold: (s: string) => string,
  refused: readonly RegExp[],
): number | undefined => {
  const chars = Array.from(value);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const prefix = chars.slice(0, i + 1).join('');
    if (refused.some((r) => r.test(ch)) || fold(prefix) !== prefix) return ch.codePointAt(0);
  }
  return undefined;
};

/**
 * Validate `backend_config` before the client is constructed (§11). Keep an unknown key a load
 * error, so that a misspelled one cannot leave every room addressed at the default MUC service and
 * every join bouncing a retryable condition that names neither the key nor this plugin.
 */
export function validateBackendConfig(config: BackendConfig): XmppBackendConfig {
  const cfg = config as Record<string, unknown>;
  assertKnownConfigKeys('xmpp', config, DECLARED);
  for (const key of CONFIG_KEYS) {
    if (key === 'mam_page') continue;
    const value = cfg[key];
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      throw bad(key, `expected a non-empty string, got ${describeConfigValue(key, value)}`);
    }
    if (typeof value === 'string') assertXmlSafe(value, `backend_config.${key}`);
  }
  for (const key of JID_PART_KEYS) {
    const value = cfg[key];
    if (typeof value === 'string' && /[\s@/]/.test(value)) {
      throw bad(
        key,
        `${describeConfigValue(key, value)} contains whitespace, '@' or '/' — it is one part of a JID, and a ` +
          'separator here builds a different address than the one written',
      );
    }
  }
  const mucService = cfg['muc_service'];
  const folded =
    typeof mucService === 'string'
      ? preppedCodepoint(mucService, nameprepFold, [MAPPED_TO_NOTHING])
      : undefined;
  if (folded !== undefined) {
    throw bad(
      'muc_service',
      `contains ${codepointLabel(folded)}, which the server folds away — a JID domainpart is ` +
        'case-insensitive and NFKC-normalized, and every room answers from the folded form, so no ' +
        'answer would match the room this bridge addressed. Write it in lowercase NFKC form',
    );
  }
  for (const key of JID_SIZED_KEYS) {
    const value = cfg[key];
    if (typeof value !== 'string') continue;
    const bytes = Buffer.byteLength(value);
    if (bytes > JID_PART_MAX_BYTES) {
      throw bad(
        key,
        `is ${bytes} bytes — over the ${JID_PART_MAX_BYTES}-byte limit on the JID part it becomes, ` +
          'which the server answers with jid-malformed on every stanza addressed through it',
      );
    }
  }
  const nick = cfg['nick'];
  if (typeof nick === 'string' && nick.includes('/')) {
    throw bad(
      'nick',
      `${describeConfigValue('nick', nick)} contains '/' — the nick is the JID resource, so this connection could ` +
        'not recognise its own presence back from the room',
    );
  }
  const rewritten = typeof nick === 'string' ? attributeNormalizedCodepoint(nick) : undefined;
  if (rewritten !== undefined) {
    throw bad(
      'nick',
      `contains ${codepointLabel(rewritten)}, which XML attribute-value normalization rewrites to ` +
        'a space in transit — the nick is the JID resource of the presence this bridge addresses ' +
        'to the room, so the room would admit it under a name it never asked for and this ' +
        'connection could not recognise its own presence back from the room. A plain space is ' +
        'fine; these three are not',
    );
  }
  const prepped =
    typeof nick === 'string'
      ? preppedCodepoint(nick, resourceprepFold, [MAPPED_TO_NOTHING, NON_ASCII_SPACE])
      : undefined;
  if (prepped !== undefined) {
    throw bad(
      'nick',
      `contains ${codepointLabel(prepped)}, which the server's resourceprep profile rewrites or ` +
        'refuses — the room would admit this connection under a nick it never asked for, and this ' +
        'connection could not recognise its own presence back from the room',
    );
  }
  const page = cfg['mam_page'];
  if (
    page !== undefined &&
    (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_MAM_PAGE)
  ) {
    throw bad(
      'mam_page',
      `expected an integer between 1 and ${MAX_MAM_PAGE}, got ${describeConfigValue('mam_page', page)}`,
    );
  }
  return cfg as XmppBackendConfig;
}

/** Longest DNS name there is; a diagnostic naming a host never needs more than this. */
const MAX_HOST_IN_DIAGNOSTIC = 253;

/** A config shape that widens this backend's trust boundary, as the fact rather than the sentence. */
export type ConfigRisk =
  | { key: 'password'; sharedDefault: string }
  | PlaintextCredentialRisk<'service', 'password'>;

/** The operator's stderr line for a risk. Rendered from the risk, so it cannot describe another. */
export function describeRisk(risk: ConfigRisk): string {
  switch (risk.key) {
    case 'password':
      return (
        `connecting with the built-in default password ('${risk.sharedDefault}'). Set ` +
        `backend_config.${risk.key} to a real secret; a network-reachable XMPP account ` +
        'provisioned with this password is world-readable/injectable.'
      );
    case 'service':
      return (
        `backend_config.${risk.key} names the host ${JSON.stringify(risk.origin)}, which can put ` +
        `${risk.exposes.map((k) => `backend_config.${k}`).join(' and ')} on the network in the ` +
        'clear — it is a non-loopback host over a plaintext scheme, or over no scheme at all, ' +
        'which @xmpp/resolve answers by DNS-SRV whose candidate list ends at a cleartext ' +
        "xmpp://…:5222. @xmpp/client's STARTTLS is opportunistic and SASL PLAIN is always offered, " +
        'so a peer that does not advertise (or that is stripped of) STARTTLS receives the ' +
        'password. Use xmpps:// or wss://.'
      );
  }
}

/**
 * What the connection about to be dialled exposes the SASL credential to. Neither is a load error —
 * a loopback dev instance on the built-in password is the documented quickstart — so the operator
 * is told rather than stopped.
 */
export function configRisks(service: string, password: string | undefined): ConfigRisk[] {
  const risks: ConfigRisk[] = [];
  if (password === undefined || password === DEFAULT_PASSWORD) {
    risks.push({ key: 'password', sharedDefault: DEFAULT_PASSWORD });
  }
  const host = plaintextRemoteHost(service);
  if (host !== undefined) {
    const origin = sanitizeBody(host).slice(0, MAX_HOST_IN_DIAGNOSTIC);
    risks.push({ key: 'service', origin, exposes: ['password'] });
  }
  return risks;
}

export function warnInsecureConfig(service: string, password: string | undefined): void {
  for (const risk of configRisks(service, password)) {
    console.warn(`[parley-xmpp] SECURITY: ${describeRisk(risk)}`);
  }
}
