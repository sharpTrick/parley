import { isLoopbackHost, type PlaintextCredentialRisk } from '@sharptrick/parley-net-util';
import type { DiscordBackendConfig } from './config.js';

/** Schemes that put a bot token on the wire in the clear, and what to use instead. */
const PLAINTEXT_SCHEMES = new Map([
  ['http:', 'https://'],
  ['ws:', 'wss://'],
]);

/** The secret-carrying endpoints an operator can point somewhere else, and what each one leaks. */
const SECRET_ENDPOINTS = {
  api_url: 'the `Authorization: Bot <token>` header of every REST call',
  gateway_url: 'the bot token in the gateway IDENTIFY',
} as const;

/**
 * A configured endpoint that would carry the bot token in the clear, as the fact rather than the
 * sentence, with the scheme to use instead.
 */
export type ConfigRisk = PlaintextCredentialRisk<keyof typeof SECRET_ENDPOINTS, 'token'> & {
  secure: string;
};

/** The operator's stderr line for a risk. Rendered from the risk, so it cannot describe another. */
export const describeRisk = (risk: ConfigRisk): string =>
  `backend_config.${risk.key} ${risk.origin} is a plaintext scheme to a non-loopback host, so ` +
  `${SECRET_ENDPOINTS[risk.key]} crosses the network unencrypted, where anyone on the path can ` +
  `take ${risk.exposes.map((k) => `backend_config.${k}`).join(' and ')} and post as this bot. ` +
  `Use ${risk.secure} for any remote endpoint.`;

/**
 * Every configured endpoint that would carry the bot token in the clear. A warning rather than a
 * load error, so that a loopback fake or a dev proxy still runs. Keep it and
 * {@link plaintextRemoteOrigin} in this PACKAGE's `src/`, so that net-util's fork registry — which
 * scans every source file of a consuming package — still names the debt it was written to hold.
 */
export function configRisks(cfg: DiscordBackendConfig): ConfigRisk[] {
  return (Object.keys(SECRET_ENDPOINTS) as Array<keyof typeof SECRET_ENDPOINTS>).flatMap((key) => {
    const plaintext = plaintextRemoteOrigin(cfg[key] ?? '');
    return plaintext === undefined ? [] : [{ key, exposes: ['token'] as const, ...plaintext }];
  });
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
