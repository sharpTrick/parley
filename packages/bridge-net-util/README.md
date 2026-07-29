# @sharptrick/parley-net-util

A tiny HTTP helper shared by Parley's HTTP chat backends (Zulip, Matrix, Discord, Telegram,
Slack). It is published to npm, so **everything below is public API** — a change to any of these
names is a breaking change.

## The loop

- **`fetchWithRetry(url, init, opts)`** — the one `fetch` + 429-retry loop. The caller passes a
  fully-formed `init` (auth headers + encoded body + optional `signal`); the helper retries `429`
  by honoring the caller's `retryAfterOf(res)` parser, stops the moment `isStopped()` is true,
  returns the `Response` on `ok`/`allowStatuses`, and otherwise throws `<label> → <status>: <text>`.
- **`FetchWithRetryOptions`** — `label`, `isStopped`, and the optional `retryAfterOf`,
  `allowStatuses`, `maxAttempts`, `deadlineMs`, `now`.

Two bounds are worth knowing before you call it:

- `deadlineMs` (default `DEFAULT_DEADLINE_MS`) is a ceiling on the **whole call including the time
  one request spends in flight** — the helper aborts a request that outlives it. A caller whose
  request legitimately blocks longer (a long-poll) must raise `deadlineMs` past its own timeout.
- A server that asks — via `Retry-After` or the caller's `retryAfterOf` — for longer than
  `MAX_BACKOFF_MS` **ends the call** rather than being retried sooner than it asked.

Errors never carry the request URL: several backends (Telegram) put a credential in the path, and
a thrown message becomes an MCP `isError` result, i.e. model context. `label` identifies the call.

## Helpers

- **`delay(ms)`** — a `setTimeout` promise (the single copy that replaces the per-plugin duplicates).
- **`clampBackoff(ms)`** — normalize a backoff into `[DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS]`.
- **`retryAfterFromHeader(res)`** — milliseconds from `Retry-After`, in **both** RFC 9110 forms
  (`delay-seconds` and HTTP-date), or `undefined` when the header carries no usable hint.
- **`sanitizeBody(text)`** — bound and flatten an untrusted response body before it goes in an
  Error: truncates at `MAX_ERROR_BODY` and strips C0/DEL, U+2028/U+2029 and bidi overrides. It
  bounds and flattens only — the body's words still reach the reader.

## Constants

`DEFAULT_BACKOFF_MS` (500), `MAX_BACKOFF_MS` (5000), `DEFAULT_MAX_ATTEMPTS` (8),
`DEFAULT_DEADLINE_MS` (30000), `MAX_ERROR_BODY` (2048).

## Why this is not `bridge-core`

`bridge-core` is a dependency-free seam that the non-HTTP backends (SQLite, Redis, NATS, Postgres)
consume without any HTTP concerns. The retry loop lives here instead so core stays HTTP-free.
Per-backend specifics that genuinely differ — auth-header building, body encoding, the
`Retry-After` **parser**, and transport response *shapes* (Slack's `ok:false` envelope, XMPP IQ) —
stay in each plugin. Only the loop/guard/cap/default/`stopped` semantics are shared.

## Releases

This is a lockstep-published package: `semantic-release` publishes it alongside every other Parley
package. Do not hand-edit its version.
