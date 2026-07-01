# Fakechat loopback

Proves the **live push path** — Claude Code's `claude/channel` capability — end to end, against
[Parley](../../README.md) running as the local SQLite backend. This is the harness the channel-docs
verification gate (`CLAUDE.md`) requires before wiring any real backend's `subscribe` into a
channel.

## Two layers

- **Automated** (`test/loopback.test.ts`): an in-process MCP `Client` over `InMemoryTransport`
  stands in for Claude Code. It asserts the server advertises the `claude/channel` capability and
  the `parley_fetch_recent` / `parley_post` / `parley_reply` tools, receives a
  `notifications/claude/channel` event when another participant posts to the same SQLite file,
  replies durably via `parley_reply`, and confirms the fetch-recent/dedup interaction (a message
  pulled via the tool is not later re-pushed by the poll loop). Run it with:

  ```bash
  npx vitest run examples/fakechat-loopback
  ```

- **Manual** ([`MANUAL-CHECKLIST.md`](MANUAL-CHECKLIST.md)): what the automated harness *can't*
  cover — driving a real, interactive `claude --channels` session. It walks through sanity-checking
  the channel mechanics against the official `fakechat` plugin, then loading Parley itself as a
  development channel (`--dangerously-load-development-channels --channels server:parley`) and
  confirming a `<channel source="parley" …>` event arrives and `parley_reply` round-trips.

## Config

[`parley.config.yaml`](parley.config.yaml) is the demo config used by Step B of the manual
checklist: `local-sqlite` backend, topic `ctx-demo`, handle `agent`, `live_push.enabled: true`,
db file `./parley-demo.db`.

## Requirements (manual checklist only)

Claude Code v2.1.80+, and either a claude.ai subscription (Pro/Max/Team/Enterprise) or a Console
API key (not Bedrock/Vertex/Foundry) — channels are a research preview. See
`MANUAL-CHECKLIST.md` for the full requirements and step-by-step pass criteria.
