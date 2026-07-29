import net from 'node:net';

/** How a fault presents on the wire. The two shapes a driver reacts to completely differently. */
export type FaultMode =
  /** Sockets are destroyed: the peer sees RST at once and reconnects immediately. */
  | 'reset'
  /** Sockets stay open and nothing flows: the peer sees a live-but-silent link (a firewall DROP). */
  | 'stall';

/**
 * A TCP proxy the tests put in front of the real NATS server so an outage can be produced (and
 * healed) deterministically. Reusable by any socket backend.
 */
export interface TcpProxy {
  /** `host:port` to hand to the plugin's `servers` config. */
  address: string;
  /** Break the link in `mode`, and refuse/blackhole new connections until `heal()`. */
  cut(mode?: FaultMode): void;
  /** Restore forwarding. Bytes stalled in flight are delivered; bytes cut by a reset are gone. */
  heal(): void;
  close(): Promise<void>;
}

export async function startTcpProxy(targetHost: string, targetPort: number): Promise<TcpProxy> {
  const live = new Set<net.Socket>();
  const stalled: (() => void)[] = [];
  let mode: 'open' | FaultMode = 'open';

  const wire = (from: net.Socket, to: net.Socket): void => {
    const held: Buffer[] = [];
    from.on('data', (chunk: Buffer) => {
      if (mode === 'stall') held.push(chunk);
      else to.write(chunk);
    });
    stalled.push(() => {
      for (const chunk of held.splice(0)) to.write(chunk);
    });
  };

  const server = net.createServer((client) => {
    if (mode === 'reset') {
      client.destroy();
      return;
    }
    live.add(client);
    // Keep a stalled connection unwired, so that a reconnect during the fault blackholes like the
    // link it is replacing instead of healing it early.
    if (mode === 'stall') return;

    const upstream = net.connect(targetPort, targetHost);
    live.add(upstream);
    const kill = (): void => {
      live.delete(client);
      live.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', kill);
    upstream.on('error', kill);
    client.on('close', kill);
    upstream.on('close', kill);
    wire(client, upstream);
    wire(upstream, client);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const destroyAll = (): void => {
    for (const s of live) s.destroy();
    live.clear();
    stalled.length = 0;
  };

  return {
    address: `127.0.0.1:${port}`,
    cut: (faultMode: FaultMode = 'reset') => {
      mode = faultMode;
      if (faultMode === 'reset') destroyAll();
    },
    heal: () => {
      const wasStalled = mode === 'stall';
      mode = 'open';
      if (wasStalled) for (const flush of stalled.splice(0)) flush();
    },
    close: async () => {
      mode = 'reset';
      destroyAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
