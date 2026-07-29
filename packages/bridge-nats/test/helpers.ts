import { connect } from 'nats';

export const SERVERS = process.env.PARLEY_NATS_SERVERS ?? '127.0.0.1:4222';

export async function isNatsUp(servers: string = SERVERS): Promise<boolean> {
  try {
    const nc = await connect({ servers, timeout: 1000, maxReconnectAttempts: 0 });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

export const rand = (): string => Math.random().toString(36).slice(2, 8);

export async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}

export async function waitForAsync(
  cond: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for async condition');
}

/** Drop every stream this run created, so a failed test cannot leak state into the next one. */
export async function dropStreams(prefix: string, servers: string = SERVERS): Promise<void> {
  const nc = await connect({ servers });
  const jsm = await nc.jetstreamManager();
  for await (const s of jsm.streams.list()) {
    if (s.config.name.startsWith(prefix)) {
      await jsm.streams.delete(s.config.name).catch(() => undefined);
    }
  }
  await nc.drain();
}
