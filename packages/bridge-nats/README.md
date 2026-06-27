# @parley/nats

NATS JetStream backend for [Parley](../../README.md) — the network-fabric backend (plugs into a
larger mesh). Implements the seam in `packages/bridge-nats/src/index.ts`; adding it required
**zero** `@parley/core` changes.

## Mapping

| Seam | NATS JetStream |
|---|---|
| topic | one JetStream **stream** per topic (`<stream_prefix><topic>`), subject `<subject_prefix><topic>` |
| `post` | `js.publish(subject, payload)` → `PubAck.seq` |
| cursor / backendMsgId | the stream **sequence** number (contiguous + monotonic per per-topic stream) |
| `fetchRecent({since})` | ephemeral consumer from `opt_start_seq = since+1` (exclusive); no `since` → last-`limit` window |
| `subscribe` | a `consume()` ordered consumer with `DeliverPolicy.New` — genuine events, not a poll timer |
| `resolveIdentity` | string convention |

One stream per topic keeps sequence numbers contiguous, so the cursor is a clean per-topic monotonic
integer. Core never compares cursor values — NATS delivers in seq order.

## Config (`backend_config`)

```yaml
backend_config:
  servers: "127.0.0.1:4222"   # string or list; default
  subject_prefix: "parley."    # default; topic → subject parley.<topic>
  stream_prefix: "PARLEY_"     # default; topic → stream PARLEY_<topic>
```

Topic tokens must not contain `.`, `*`, `>`, or whitespace (NATS subject rules); they're sanitized
to `_` for safety.

## Run NATS (JetStream)

Use the **official `nats` Docker image** (not authored here); JetStream is a single flag:

```bash
docker run -d --name parley-nats -p 4222:4222 nats:2.10-alpine -js
```

(or the maintainer dev harness: `examples/dev-compose/`.)

## Conformance

```bash
docker run -d --name parley-nats -p 4222:4222 nats:2.10-alpine -js
npm test   # the shared @parley/conformance suite runs green against NATS
```

`PARLEY_NATS_SERVERS` overrides the servers; the suite skips itself if no server is reachable.
