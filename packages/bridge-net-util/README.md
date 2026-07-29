# @sharptrick/parley-net-util

A tiny HTTP helper: one `fetch` + 429-retry loop, plus the `delay` any backend that waits needs.
It is published to npm, so **everything below is public API** — a change to any of these names is
a breaking change.

- **Consumed by:** Discord, Matrix, Postgres, Slack, Telegram, XMPP, Zulip.
- **Not consumed by:** NATS, Redis, SQLite.

Both lines are re-derived from the workspace manifests by this package's own tests, so a backend
that gains or drops the dependency moves them.

## The loop

- **`fetchWithRetry(url, init, opts)`** — the one `fetch` + 429-retry loop. The caller passes a
  fully-formed `init` (auth headers + encoded body + optional `signal`); the helper retries `429`
  by honoring the caller's `retryAfterOf(res)` parser, abandons a backoff within `STOP_POLL_MS` of
  `isStopped()` turning true, returns the `Response` on `ok`/`allowStatuses`, and otherwise throws
  `<label> → <status>: <text>`. The `Response` you get back is already buffered, so your own
  `res.json()` can never be aborted by the helper's deadline.
- **`FetchWithRetryOptions`** — `label`, `isStopped`, and the optional `retryAfterOf`,
  `allowStatuses`, `maxAttempts`, `deadlineMs`, `now`.
- **`HttpStatusError`** — what an unallowed non-2xx throws. Its `message` is exactly
  `` `${label} → ${status}: ${body}` `` — a pinned contract, since several backends' tests read it —
  and it also carries `label`, `status` and `body` as fields.
- **`statusOf(err)`** — the status behind such a rejection, or `undefined`. Branch on this instead
  of re-parsing the message; it matches by `name`, so a duplicated copy of this package still works.

Two bounds are worth knowing before you call it:

- `deadlineMs` (default `DEFAULT_DEADLINE_MS`) is a ceiling on the **whole call including the time
  one request spends in flight** — the helper aborts a request that outlives it. A caller whose
  request legitimately blocks longer (a long-poll) must raise `deadlineMs` past its own timeout.
- A wait the server states — via `Retry-After` or the caller's `retryAfterOf` — is honoured in
  **full**, however long; it is refused, **ending the call**, only when it would not fit inside
  this call's `deadlineMs`. `MAX_BACKOFF_MS` clamps only a backoff the helper invented itself.

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
`DEFAULT_DEADLINE_MS` (30000), `MAX_ERROR_BODY` (2048), `STOP_POLL_MS` (25 — how often a backoff
re-reads `isStopped()`, i.e. the longest a disconnect waits on one).

## Why this is not `bridge-core`

`bridge-core` is a dependency-free seam, and several backends consume it without any HTTP concerns
at all. The retry loop lives here instead so core stays HTTP-free. Note that "not an HTTP backend"
and "not a consumer of this package" are different claims: Postgres and XMPP speak their own wire
protocols and still depend on this package for `delay`.
Per-backend specifics that genuinely differ — auth-header building, body encoding, the
`Retry-After` **parser**, and transport response *shapes* (Slack's `ok:false` envelope, XMPP IQ) —
stay in each plugin. Only the loop/guard/cap/default/`stopped` semantics are shared.

## Releases

This is a lockstep-published package: `semantic-release` publishes it alongside every other Parley
package. Do not hand-edit its version.
