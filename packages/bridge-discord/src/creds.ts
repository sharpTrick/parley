import { isLoopbackHost } from '@sharptrick/parley-net-util';
import type { DiscordBackendConfig } from './config.js';

/** Schemes that put a bot token on the wire in the clear, and what to use instead. */
const PLAINTEXT_SCHEMES = new Map([
  ['http:', 'https://'],
  ['ws:', 'wss://'],
]);

/** The secret-carrying endpoints an operator can point somewhere else, and what each one leaks. */
const SECRET_ENDPOINTS: Array<[key: 'api_url' | 'gateway_url', carries: string]> = [
  ['api_url', 'the `Authorization: Bot <token>` header of every REST call'],
  ['gateway_url', 'the bot token in the gateway IDENTIFY'],
];

/**
 * Every configured endpoint that would carry the bot token in the clear, phrased for the operator's
 * stderr. A warning rather than a load error, so that a loopback fake or a dev proxy still runs.
 * Keep it and {@link plaintextRemoteOrigin} in this PACKAGE's `src/`, so that net-util's fork
 * registry — which scans every source file of a consuming package — still names the debt it was
 * written to hold.
 */
export function plaintextCredentialRisks(cfg: DiscordBackendConfig): string[] {
  const risks: string[] = [];
  for (const [key, carries] of SECRET_ENDPOINTS) {
    const plaintext = plaintextRemoteOrigin(cfg[key] ?? '');
    if (plaintext === undefined) continue;
    risks.push(
      `backend_config.${key} ${plaintext.origin} is a plaintext scheme to a non-loopback host, so ` +
        `${carries} crosses the network unencrypted, where anyone on the path can take the token ` +
        `and post as this bot. Use ${plaintext.secure} for any remote endpoint.`,
    );
  }
  return risks;
}

function plaintextRemoteOrigin(raw: string): { origin: string; secure: string } | undefined {
  try {
    const { protocol, hostname, origin } = new URL(raw);
    const secure = PLAINTEXT_SCHEMES.get(protocol);
    return secure !== undefined && !isLoopbackHost(hostname) ? { origin, secure } : undefined;
  } catch {
    return undefined;
  }
}
