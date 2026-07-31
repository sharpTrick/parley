import type { BackendConfig } from '@sharptrick/parley-core';

import { JID_PART_MAX_BYTES } from './jid.js';
import { assertXmlSafe } from './stanzas.js';

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

/** Every key `backend_config` may carry. Also the set README and DESIGN §11 are checked against. */
export const CONFIG_KEYS = [
  'service',
  'domain',
  'muc_service',
  'username',
  'password',
  'nick',
  'mam_page',
] as const;
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
 * The whole 127.0.0.0/8 block as an ADDRESS. Keep it anchored at both ends, so that a registrable
 * hostname beginning `127.` cannot be classified loopback and silence the only warning on the
 * cleartext-credential path.
 */
const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/;

/**
 * Whether `service` may put the SASL password on the network in the clear. `@xmpp/starttls` upgrades
 * only when the peer ADVERTISES the feature and `@xmpp/client` registers SASL PLAIN unconditionally,
 * so an on-path attacker that strips `<starttls/>` from the stream features is handed the credential.
 * A service carrying no scheme is UNKNOWN transport, not safe transport: `@xmpp/resolve` routes it
 * through DNS-SRV, whose candidate list always ends at a cleartext `xmpp://<addr>:5222`.
 */
export function isPlaintextRemote(service: string): boolean {
  const trimmed = service.trim();
  const mark = trimmed.indexOf('://');
  const scheme = mark === -1 ? undefined : trimmed.slice(0, mark + 1).toLowerCase();
  if (scheme !== undefined && ENCRYPTED_SCHEMES.includes(scheme)) return false;
  const authority = (mark === -1 ? trimmed : trimmed.slice(mark + 3)).replace(/^\/\//, '');
  const host = (/^([^/?#]*)/.exec(authority)?.[1] ?? '')
    .replace(/^[^@]*@/, '')
    .replace(/^(\[[^\]]*]):\d+$/, '$1')
    .replace(/^\[(.*)]$/, '$1')
    .replace(/^([^:]*):\d+$/, '$1')
    .toLowerCase();
  return !(host === 'localhost' || host === '::1' || LOOPBACK_V4.test(host) || host === '');
}

const describeValue = (v: unknown): string => (typeof v === 'string' ? `'${v}'` : String(v));
const bad = (key: string, reason: string): Error =>
  new Error(`parley-xmpp: invalid backend_config.${key} — ${reason}`);

/**
 * Validate `backend_config` before the client is constructed (§11). Keep an unknown key a load
 * error, so that a misspelled one cannot leave every room addressed at the default MUC service and
 * every join bouncing a retryable condition that names neither the key nor this plugin.
 */
export function validateBackendConfig(config: BackendConfig): XmppBackendConfig {
  const cfg = config as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `parley-xmpp: unknown backend_config key '${key}' — expected one of ${CONFIG_KEYS.join(', ')}`,
      );
    }
  }
  for (const key of CONFIG_KEYS) {
    if (key === 'mam_page') continue;
    const value = cfg[key];
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      throw bad(key, `expected a non-empty string, got ${describeValue(value)}`);
    }
    if (typeof value === 'string') assertXmlSafe(value, `backend_config.${key}`);
  }
  for (const key of JID_PART_KEYS) {
    const value = cfg[key];
    if (typeof value === 'string' && /[\s@/]/.test(value)) {
      throw bad(
        key,
        `${describeValue(value)} contains whitespace, '@' or '/' — it is one part of a JID, and a ` +
          'separator here builds a different address than the one written',
      );
    }
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
      `${describeValue(nick)} contains '/' — the nick is the JID resource, so this connection could ` +
        'not recognise its own presence back from the room',
    );
  }
  const page = cfg['mam_page'];
  if (
    page !== undefined &&
    (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_MAM_PAGE)
  ) {
    throw bad(
      'mam_page',
      `expected an integer between 1 and ${MAX_MAM_PAGE}, got ${describeValue(page)}`,
    );
  }
  return cfg as XmppBackendConfig;
}

/**
 * What the connection about to be dialled exposes the SASL credential to. Neither is a load error —
 * a loopback dev instance on the built-in password is the documented quickstart — so the operator
 * is told rather than stopped.
 */
export function warnInsecureConfig(service: string, password: string | undefined): void {
  if (password === undefined || password === DEFAULT_PASSWORD) {
    console.warn(
      '[parley-xmpp] SECURITY: connecting with the built-in default password ' +
        "('parleypass'). Set backend_config.password to a real secret; a network-reachable " +
        'XMPP account provisioned with this password is world-readable/injectable.',
    );
  }
  if (isPlaintextRemote(service)) {
    console.warn(
      `[parley-xmpp] SECURITY: service ${service} can put backend_config.password on the ` +
        'network in the clear — it names a non-loopback host over a plaintext scheme, or over ' +
        'no scheme at all, which @xmpp/resolve answers by DNS-SRV whose candidate list ends at ' +
        "a cleartext xmpp://…:5222. @xmpp/client's STARTTLS is opportunistic and SASL PLAIN is " +
        'always offered, so a peer that does not advertise (or that is stripped of) STARTTLS ' +
        'receives the password. Use xmpps:// or wss://.',
    );
  }
}
