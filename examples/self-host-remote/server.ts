import { pathToFileURL } from 'node:url';
import {
  createRemoteAuthApp,
  loadConfig,
  makeOwnerVerifier,
  ownerVerifierFromPassphrase,
} from '@sharptrick/parley-core';
import { SqlitePlugin } from '@sharptrick/parley-sqlite';

export interface RemoteServerHandle {
  /** The bound origin, e.g. http://127.0.0.1:3000 */
  origin: string;
  close(): Promise<void>;
}

export interface StartRemoteOptions {
  configPath: string;
  /** Public base URL Claude reaches. In the built-in auth mode this is also the OAuth issuer
   *  (AS = RS); in oidc mode it is only the resource origin — the issuer is the external IdP
   *  from the config's auth.oidc block. HTTPS in production. */
  issuerUrl: URL;
  port: number;
  host?: string;
  /** Owner secret, provided LOCALLY (env/stdin) — never over the public internet.
   *  Required in the built-in auth mode only; unused (and not required) in oidc mode. */
  ownerPassphrase?: string;
  /** Or a pre-computed scrypt hash (`scrypt$salt$hash`) for at-rest storage. */
  ownerSecretHash?: string;
}

/**
 * Reference remote-mode composition root (DESIGN §10): SqlitePlugin + the auth front door over
 * Streamable HTTP. The rich config stays server-side; Claude only ever holds a consented token.
 * cfg.auth.mode selects between the built-in single-tenant OAuth AS (default) and delegating
 * authorization to an external OIDC IdP such as Keycloak (docs/keycloak-integration.md).
 */
export async function startRemoteServer(opts: StartRemoteOptions): Promise<RemoteServerHandle> {
  const cfg = loadConfig(opts.configPath);
  const plugin = new SqlitePlugin();
  await plugin.connect(cfg.backend_config);

  // The owner secret gates the built-in consent flow only; in oidc mode the IdP owns login,
  // so no local secret is needed (or read).
  const verifyOwner =
    cfg.auth.mode === 'builtin'
      ? opts.ownerSecretHash !== undefined
        ? makeOwnerVerifier(opts.ownerSecretHash)
        : ownerVerifierFromPassphrase(requireSecret(opts.ownerPassphrase))
      : undefined;

  const app = await createRemoteAuthApp(plugin, cfg, {
    publicUrl: opts.issuerUrl,
    ...(verifyOwner !== undefined ? { verifyOwner } : {}),
  });
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
  // PARLEY_PUBLIC_URL is the preferred name; PARLEY_ISSUER_URL is kept as a compatible alias
  // (in the built-in mode the public URL IS the issuer; in oidc mode the issuer is the IdP).
  const publicUrl = process.env.PARLEY_PUBLIC_URL ?? process.env.PARLEY_ISSUER_URL;
  if (publicUrl === undefined) {
    throw new Error('Set PARLEY_PUBLIC_URL (the public https origin Claude reaches).');
  }
  const issuerUrl = new URL(publicUrl);
  const port = Number(process.env.PORT ?? issuerUrl.port ?? '3000') || 3000;
  const configPath =
    process.env.PARLEY_CONFIG ?? new URL('./parley.config.yaml', import.meta.url).pathname;

  const cfg = loadConfig(configPath);
  const handle = await startRemoteServer({
    configPath,
    issuerUrl,
    port,
    host: process.env.HOST ?? '127.0.0.1',
    ...(process.env.PARLEY_OWNER_SECRET_HASH !== undefined
      ? { ownerSecretHash: process.env.PARLEY_OWNER_SECRET_HASH }
      : process.env.PARLEY_OWNER_PASSPHRASE !== undefined
        ? { ownerPassphrase: process.env.PARLEY_OWNER_PASSPHRASE }
        : {}),
  });

  const authNote =
    cfg.auth.mode === 'oidc'
      ? `auth: oidc, delegated to ${cfg.auth.oidc?.issuer ?? '?'}`
      : 'auth: builtin single-tenant OAuth';
  process.stderr.write(
    `parley remote: listening on ${handle.origin} (public URL ${issuerUrl.href}; ${authNote})\n`,
  );
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
