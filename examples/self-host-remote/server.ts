import { pathToFileURL } from 'node:url';
import {
  createOAuthRemoteApp,
  loadConfig,
  makeOwnerVerifier,
  ownerVerifierFromPassphrase,
} from '@parley/core';
import { SqlitePlugin } from '@parley/sqlite';

export interface RemoteServerHandle {
  /** The bound origin, e.g. http://127.0.0.1:3000 */
  origin: string;
  close(): Promise<void>;
}

export interface StartRemoteOptions {
  configPath: string;
  /** Public origin Claude reaches (issuer = base = resource origin). HTTPS in production. */
  issuerUrl: URL;
  port: number;
  host?: string;
  /** Owner secret, provided LOCALLY (env/stdin) — never over the public internet. */
  ownerPassphrase?: string;
  /** Or a pre-computed scrypt hash (`scrypt$salt$hash`) for at-rest storage. */
  ownerSecretHash?: string;
}

/**
 * Reference remote-mode composition root (DESIGN §10): SqlitePlugin + the OAuth front door over
 * Streamable HTTP. The rich config stays server-side; Claude only ever holds a consented token.
 */
export async function startRemoteServer(opts: StartRemoteOptions): Promise<RemoteServerHandle> {
  const cfg = loadConfig(opts.configPath);
  const plugin = new SqlitePlugin();
  await plugin.connect(cfg.backend_config);

  const verifyOwner =
    opts.ownerSecretHash !== undefined
      ? makeOwnerVerifier(opts.ownerSecretHash)
      : ownerVerifierFromPassphrase(requireSecret(opts.ownerPassphrase));

  const app = createOAuthRemoteApp(plugin, cfg, { issuerUrl: opts.issuerUrl, verifyOwner });
  await app.listen(opts.port, opts.host ?? '127.0.0.1');

  return {
    origin: opts.issuerUrl.origin,
    async close() {
      await app.close();
      await plugin.disconnect();
    },
  };
}

function requireSecret(passphrase: string | undefined): string {
  if (passphrase === undefined || passphrase.length === 0) {
    throw new Error(
      'No owner secret. Set PARLEY_OWNER_PASSPHRASE (or PARLEY_OWNER_SECRET_HASH) locally — ' +
        'it must NEVER cross the public internet at setup.',
    );
  }
  return passphrase;
}

// CLI entrypoint: `node server.ts` (after `npm run build`). Reads secrets from the LOCAL env.
async function main(): Promise<void> {
  const issuer = process.env.PARLEY_ISSUER_URL;
  if (issuer === undefined) throw new Error('Set PARLEY_ISSUER_URL (the public https origin Claude reaches).');
  const issuerUrl = new URL(issuer);
  const port = Number(process.env.PORT ?? issuerUrl.port ?? '3000') || 3000;

  const handle = await startRemoteServer({
    configPath: process.env.PARLEY_CONFIG ?? new URL('./parley.config.yaml', import.meta.url).pathname,
    issuerUrl,
    port,
    host: process.env.HOST ?? '127.0.0.1',
    ...(process.env.PARLEY_OWNER_SECRET_HASH !== undefined
      ? { ownerSecretHash: process.env.PARLEY_OWNER_SECRET_HASH }
      : { ownerPassphrase: process.env.PARLEY_OWNER_PASSPHRASE }),
  });

  process.stderr.write(`parley remote: listening on ${handle.origin} (issuer ${issuerUrl.href})\n`);
  const shutdown = (): void => void handle.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`parley remote: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
