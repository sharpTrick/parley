import { plaintextRemoteOrigin } from '@sharptrick/parley-net-util';

/**
 * Diagnostics go to stderr — stdout is the MCP JSON-RPC channel (see cli.ts). Keep every line the
 * plugin and its store emit going through here, so that one prefix names the source of all of them.
 */
export function note(message: string): void {
  process.stderr.write(`parley-telegram: ${message}\n`);
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A throttled stderr surface. `kind` names a failure CLASS and holds it to one line a minute;
 * classes throttle independently, so a chattering poll failure cannot silence a store write that is
 * losing messages. `redact` is applied to every message, so that a new diagnostic cannot put a
 * credential into model context or the operator's logs.
 */
export class Diagnostics {
  private readonly lastReportAt = new Map<string, number>();

  constructor(private readonly redact: (text: string) => string = (text) => text) {}

  report(message: string, kind?: string): void {
    if (kind !== undefined) {
      const now = Date.now();
      if (now - (this.lastReportAt.get(kind) ?? 0) < 60_000) return;
      this.lastReportAt.set(kind, now);
    }
    note(this.redact(message));
  }
}

/**
 * The `connect`-time warning a plaintext `api_url` earns, or `undefined`. Names the ORIGIN only, so
 * that a secret smuggled into userinfo or a path is not what the warning itself prints.
 */
export function plaintextWarning(apiUrl: string): string | undefined {
  const origin = plaintextRemoteOrigin(apiUrl);
  if (origin === undefined) return undefined;
  return (
    `SECURITY: backend_config.api_url ${origin} is plaintext http:// to a non-loopback ` +
    `host. This API carries the bot token in the URL PATH, so every request line puts it ` +
    `on the network in the clear and into the logs of every proxy on the way. Use https://.`
  );
}
