# @sharptrick/parley-net-util

A tiny HTTP helper: one `fetch` + 429-retry loop, plus the `delay` any backend that waits needs.
It is published to npm, so **everything below is public API** — a change to any of these names is
a breaking change.

- **Consumed by:** Discord, Matrix, NATS, Postgres, Redis, Slack, Telegram, XMPP, Zulip.
- **Not consumed by:** SQLite.

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
  `allowStatuses`, `maxAttempts`, `deadlineMs`, `maxBodyBytes`, `now`.
- **`HttpStatusError`** — what an unallowed non-2xx throws. Its `message` is exactly
  `` `${label} → ${status}: ${body}` `` — a pinned contract, since several backends' tests read it —
  and it also carries `label`, `status` and `body` as fields.
- **`statusOf(err)`** — the status behind a rejection, or `undefined` when no response was received.
  Branch on this instead of re-parsing the message; it reads the `status` field rather than the
  class, so a duplicated copy of this package still works — and every rejection raised *after* a
  status arrived reports it, including the ones that fail while reading the body (`→ body:`,
  `→ transport:`, `→ deadline:`), not only the `<label> → <status>: <body>` one.

Three bounds are worth knowing before you call it:

- `deadlineMs` (default `DEFAULT_DEADLINE_MS`) is a ceiling on the **whole call including the time
  one request spends in flight** — the helper aborts a request that outlives it. A caller whose
  request legitimately blocks longer (a long-poll) must raise `deadlineMs` past its own timeout.
- A wait the server states — via `Retry-After` or the caller's `retryAfterOf` — is honoured in
  **full**, however long; it is refused, **ending the call**, only when it would not fit inside
  this call's `deadlineMs`. The only backoff the helper invents for itself is the fixed
  `DEFAULT_BACKOFF_MS`, used when a 429 carries no usable hint at all; nothing in this loop clamps
  a stated one. (`clampBackoff`/`MAX_BACKOFF_MS` are for a **plugin's own** reconnect ladder — the
  loop does not call them.)
- `maxBodyBytes` (default `MAX_RESPONSE_BYTES`) is a ceiling on the bytes **one response** puts in
  memory, applied while reading rather than after: a response over it fails with
  `<label> → body: …` instead of handing back a body your `res.json()` would misparse. It applies
  only to a response you are HANDED (a 2xx, or an `allowStatuses` one). A response you never see —
  an error body, and a 429 the loop only retries on — is read to a few kilobytes and the rest
  dropped, so a hostile upstream cannot spend your RSS producing a 2 KB message however many times
  it repeats the status. A 429 body is bounded by that same few kilobytes when your `retryAfterOf`
  reads it, which is ample for a JSON rate-limit envelope.

The `Retry-After` header is a **floor**, and `retryAfterOf` is a source of an *additional* hint,
never a ceiling: whichever is longer wins. Do not clamp what your parser returns — retrying
sooner than the vendor asked is what escalates a rate limit into a global ban, and this loop will
not let a parser do it. A parser that throws or rejects — `res.clone().json()` against a CDN's HTML
429 page — counts as no hint rather than failing the call, and the header floor still applies. A
header set twice (a gateway plus the origin) reads as the longest wait either value states, not as
no hint at all. An HTTP-date is read against the response's own `Date` header where there is one, so
a skewed client clock cannot turn a stated wait into no hint.

Errors never carry the request URL: several backends (Telegram) put a credential in the path, and
a thrown message becomes an MCP `isError` result, i.e. model context. `label` identifies the call.
Redaction covers the URL byte-for-byte, any `scheme://…` spelling of it, and every component that
can carry a credential on its own — the whole path, every path segment **and every query value**
that is `:`-bearing or long and not spelled like a method name (Telegram's `bot<id>:<token>` and
Discord's punctuation-free webhook token are both covered; `getUpdates` and `chat.postMessage` are
left in the body's prose, where an API's own error text uses them), and the userinfo, each in both
its encoded and decoded spelling — so a proxy or a hostile body that echoes one fragment alone is
covered too. Long means **longer than 8 characters**: at or under that lies the routing vocabulary a
backend puts in a query string — Matrix's `timeout=30000`, Zulip's `dont_block=false` and
`anchor=newest` — and striking those out would gut the body that explains itself with them.
Userinfo takes neither exemption: it is credential-by-construction, so a short password is redacted
too. The method-name exemption is bounded at **24 characters**: a longer run of letters and
dots is a JWT or an alphabetic token, not a word, and is redacted like any other opaque segment.
A bare `host/path` with no scheme is not treated as a URL, so keep credentials out of the host, out
of a path segment or query value short enough to pass for `api` or `v1`, and out of one
**24 characters or shorter** spelled with letters and dots alone — `postMessage` is
indistinguishable from an 11-letter secret.

A rejection is labelled and redacted whatever the caller's own `signal` is doing. Only an abort
that IS the caller's own comes back raw — tearing a plugin down mid-request cannot turn a DNS or
TLS failure into an unenveloped one just by racing it.

## Helpers

- **`delay(ms)`** — a `setTimeout` promise (the single copy that replaces the per-plugin duplicates).
- **`clampBackoff(ms)`** — normalize a backoff **a plugin chose itself** (a reconnect ladder, a poll
  interval) into `[DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS]` — a figure under the floor comes back AS the
  floor, so a ladder built on a misparsed hint cannot hot-spin. `fetchWithRetry` never calls it: a
  wait the server stated must not be clamped.
- **`retryAfterFromHeader(res)`** — milliseconds from `Retry-After`, in **both** RFC 9110 forms
  (`delay-seconds`, decimal only, plus the de-facto fraction; and HTTP-date), or `undefined` when
  the header carries no usable hint. A multi-valued header yields the **longest** wait any of its
  field-values states.
- **`sanitizeBody(text)`** — bound and flatten an untrusted response body before it goes in an
  Error: truncates at `MAX_ERROR_BODY` (never between the halves of an astral character) and strips
  every Unicode control (`Cc`, i.e. C0, C1 and DEL) and format (`Cf`, i.e. bidi overrides,
  isolates, joiners, BOM) character, plus U+2028/U+2029, replacing unpaired surrogates. It bounds
  and flattens only — the body's words still reach the reader.

## Plaintext-credential classification

- `isLoopbackHost(hostname)` — loopback iff the host is exactly `localhost` or a literal
  `127.0.0.0/8` / `::1` address. A parse, not a prefix match, so a resolvable DNS name shaped like an
  address (`127.0.0.1.example.com`, `localhost.example.com`) is classified by what it *is* and still
  gets warned about. Anything unproven — including an IPv4-mapped spelling of a loopback address —
  counts as remote: the safe direction is to warn.
- `plaintextRemoteOrigin(url)` — the ORIGIN to name when the URL would put a credential on the wire
  in the clear, else `undefined`. Naming the origin rather than the whole configured URL keeps a
  secret smuggled into a path out of stderr, and out of the tool result core hands the model. The
  cleartext side is everything that is **not** a known-secure scheme (`https:`, `wss:`), so `ws:` —
  how a gateway handshake carries a bot token — warns, and so does a scheme this classifier has
  never met: `undefined` reads as "no plaintext-credential risk", which is not an answer to give
  about an unproven scheme. A URL with no host (`file:`, `mailto:`) names no remote endpoint and
  answers `undefined`.

These live here so the backends that warn about the same thing share one classifier: a security
predicate copied per backend is a predicate fixed in one place and left wrong in the others.

## Constants

`DEFAULT_BACKOFF_MS` (500), `MAX_BACKOFF_MS` (5000 — the ceiling `clampBackoff` applies to a
plugin's own ladder, not to anything `fetchWithRetry` does), `DEFAULT_MAX_ATTEMPTS` (8),
`DEFAULT_DEADLINE_MS` (30000), `MAX_ERROR_BODY` (2048), `MAX_RESPONSE_BYTES` (16 MiB — the default
`maxBodyBytes`), `STOP_POLL_MS` (25 — how often a backoff re-reads `isStopped()`, i.e. the longest a
disconnect waits on one).

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
