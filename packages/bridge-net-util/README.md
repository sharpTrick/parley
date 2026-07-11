# @sharptrick/parley-net-util

A tiny internal HTTP helper shared by Parley's HTTP chat backends (Zulip, Matrix, Discord,
Telegram, Slack). It exports exactly two things:

- **`fetchWithRetry(url, init, opts)`** — the one `fetch` + 429-retry loop. The caller passes a
  fully-formed `init` (auth headers + encoded body + optional `signal`); the helper retries `429`
  by honoring the caller's `retryAfterOf(res)` parser, stops the moment `isStopped()` is true,
  returns the `Response` on `ok`/`allowStatuses`, and otherwise throws `<label> → <status>: <text>`.
- **`delay(ms)`** — a `setTimeout` promise (the single copy that replaces the per-plugin duplicates).

## Why this is not `bridge-core`

`bridge-core` is a dependency-free seam that the non-HTTP backends (SQLite, Redis, NATS, Postgres)
consume without any HTTP concerns. The retry loop lives here instead so core stays HTTP-free.
Per-backend specifics that genuinely differ — auth-header building, body encoding, the
`Retry-After` **parser**, and transport response *shapes* (Slack's `ok:false` envelope, XMPP IQ) —
stay in each plugin. Only the loop/guard/cap/default/`stopped` semantics are shared.

## Releases

This is a lockstep-published package: `semantic-release` publishes it alongside every other Parley
package. Do not hand-edit its version.
