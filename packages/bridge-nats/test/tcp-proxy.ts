import net from 'node:net';

/**
 * A TCP proxy the tests put in front of the real NATS server so an outage can be produced (and
 * healed) deterministically: `cut()` resets every live socket and refuses new ones, `heal()` lets
 * them through again. Reusable by any socket backend.
 */
export interface TcpProxy {
  /** `host:port` to hand to the plugin's `servers` config. */
  address: string;
  /** Reset every live connection and refuse new ones until `heal()`. */
  cut(): void;
  /** Accept connections again. */
  heal(): void;
  close(): Promise<void>;
}

export async function startTcpProxy(targetHost: string, targetPort: number): Promise<TcpProxy> {
  const live = new Set<net.Socket>();
  let cutOff = false;

  const server = net.createServer((client) => {
    if (cutOff) {
      client.destroy();
      return;
    }
    const upstream = net.connect(targetPort, targetHost);
    live.add(client);
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
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    address: `127.0.0.1:${port}`,
    cut: () => {
      cutOff = true;
      for (const s of live) s.destroy();
      live.clear();
    },
    heal: () => {
      cutOff = false;
    },
    close: async () => {
      cutOff = true;
      for (const s of live) s.destroy();
      live.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
