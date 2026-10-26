import type { BackendConfig } from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import { connect, Events } from 'nats';
import type { JetStreamClient, JetStreamManager, NatsConnection } from 'nats';
import {
  assertKnownBackendConfig,
  assertNoServerCredentials,
  configRisks,
  connectionOptions,
  describeRisk,
  type NatsBackendConfig,
  validatePrefix,
  validateRetentionMaxAgeNs,
} from './config.js';
import { DRAIN_TIMEOUT_MS, type Closeable } from './jetstream.js';
import { MAX_STREAM_NAME_BYTES, MAX_SUBJECT_BYTES } from './naming.js';

/** The link, the addressing it was opened with, and everything `disconnect()` has to give back. */
export abstract class NatsSession {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  protected subjectPrefix = 'parley.';
  protected streamPrefix = 'PARLEY_';
  protected retentionMaxAgeNs?: number;
  private connecting = false;
  protected stopped = false;
  protected epoch = 0;
  protected readonly ensured = new Map<string, Promise<void>>();
  protected readonly incarnations = new Map<string, string>();
  protected readonly subscriptions: Closeable[] = [];
  protected readonly onReconnect = new Set<() => void>();

  async connect(config: BackendConfig): Promise<void> {
    if (this.nc !== undefined || this.connecting) {
      throw new Error(
        'parley-nats: already connected (or a connect() is still in flight) — call disconnect() ' +
          'first. A second connect() would strand the previous connection, whose unbounded ' +
          'reconnect loop keeps its socket alive with no way for the caller to reclaim it',
      );
    }
    assertKnownBackendConfig(config);
    const cfg = config as NatsBackendConfig;
    const subjectPrefix = validatePrefix('subject_prefix', cfg.subject_prefix, 'parley.', /[*>\s]/, MAX_SUBJECT_BYTES);
    const streamPrefix = validatePrefix('stream_prefix', cfg.stream_prefix, 'PARLEY_', /[.*>/\\\s]/, MAX_STREAM_NAME_BYTES);
    const retentionMaxAgeNs = validateRetentionMaxAgeNs(cfg.retention_days);
    assertNoServerCredentials(cfg);
    // Report on stderr, NEVER stdout, so that cli.ts's JSON-RPC channel stays parseable.
    for (const risk of configRisks(cfg)) console.warn(`[parley-nats] SECURITY: ${describeRisk(risk)}`);
    const epoch = this.epoch;
    this.connecting = true;
    let nc: NatsConnection;
    let jsm: JetStreamManager;
    try {
      nc = await connect(connectionOptions(cfg));
      try {
        jsm = await nc.jetstreamManager();
      } catch (err) {
        await nc.close().catch(() => undefined);
        throw err;
      }
    } finally {
      this.connecting = false;
    }
    // Keep the epoch check: `disconnect()` that landed inside this connect() found no handles to
    // tear down, so publishing these ones now hands a caller that already awaited teardown a live
    // plugin — and drops a socket whose unbounded reconnect loop nobody can reach.
    if (this.epoch !== epoch) {
      await nc.close().catch(() => undefined);
      throw new Error(
        'parley-nats: disconnect() landed inside this connect() — the new connection was closed ' +
          'instead of published. Call connect() again if the plugin is meant to be live.',
      );
    }
    this.subjectPrefix = subjectPrefix;
    this.streamPrefix = streamPrefix;
    this.retentionMaxAgeNs = retentionMaxAgeNs;
    this.stopped = false;
    this.epoch += 1;
    this.ensured.clear();
    this.incarnations.clear();
    this.nc = nc;
    this.js = nc.jetstream();
    this.jsm = jsm;
    void this.announceReconnects(nc);
  }

  private async announceReconnects(nc: NatsConnection): Promise<void> {
    try {
      for await (const s of nc.status()) {
        if (s.type === Events.Reconnect) for (const listener of [...this.onReconnect]) listener();
      }
    } catch {
      /* status iterator closed with the connection */
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.epoch += 1;
    const closing = this.subscriptions.splice(0).map(async (sub) => {
      try {
        await sub.close();
      } catch {
        /* already closing */
      }
    });
    // Keep the bounded race: a closer that deletes a server-side consumer needs the link, which is
    // exactly what an outage teardown does not have.
    await Promise.race([Promise.all(closing), delay(DRAIN_TIMEOUT_MS)]);
    const nc = this.nc;
    this.nc = undefined;
    this.js = undefined;
    this.jsm = undefined;
    if (nc !== undefined) {
      // Keep the bounded race: `maxReconnectAttempts: -1` means drain() never settles while the
      // link is down, so an unraced await here hangs teardown for the life of the outage.
      await Promise.race([nc.drain().catch(() => undefined), delay(DRAIN_TIMEOUT_MS)]);
      await nc.close().catch(() => undefined);
    }
  }

  /** The only two reasons the live loop may stop rebuilding: teardown began, or the link is gone. */
  protected live(): boolean {
    return !this.stopped && this.nc !== undefined && !this.nc.isClosed();
  }

  protected unregister(closer: Closeable): void {
    const i = this.subscriptions.indexOf(closer);
    if (i >= 0) this.subscriptions.splice(i, 1);
  }

  protected requireJs(): JetStreamClient {
    if (this.js === undefined) throw new Error('NatsPlugin not connected — call connect() first');
    return this.js;
  }
  protected requireJsm(): JetStreamManager {
    if (this.jsm === undefined) throw new Error('NatsPlugin not connected — call connect() first');
    return this.jsm;
  }
}
