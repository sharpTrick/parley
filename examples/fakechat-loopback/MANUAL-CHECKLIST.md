# Fakechat loopback — manual checklist (live `claude --channels`)

The automated harness (`test/loopback.test.ts`) proves the push flow headlessly: an in-process
MCP client connects to the real Parley bridge, asserts the `claude/channel` capability, receives
`notifications/claude/channel` events when another participant posts, and replies durably. What it
**cannot** do is drive a real interactive Claude Code session — that needs your hands. This file
is that last mile.

## Requirements

- **Claude Code v2.1.80+** (channels are a research preview; permission relay needs v2.1.81+).
- **Auth:** a claude.ai subscription (Pro/Max/Team/Enterprise) **or** a Console API key.
  > Note: DESIGN.md §2.2 said API-key auth is unsupported, but the live channels docs allow
  > "claude.ai **or** a Console API key". The docs win (recorded in `PROGRESS.md`).
  > Not available on Bedrock / Vertex / Foundry.
- Channels enabled for your org if you're on Team/Enterprise (`channelsEnabled` policy).
- Build first: from the repo root, `npm install && npm run build`.

## Step A — sanity-check the channel mechanics with the official fakechat

Confirms your CLI honors the channel contract before pointing it at Parley.

```bash
claude --dangerously-load-development-channels --channels plugin:fakechat@claude-plugins-official
```

Open the fakechat UI (the startup notice prints the localhost URL, typically
<http://localhost:8787>), send a message, and confirm it arrives in the session as a
`<channel source="fakechat" …>` event and Claude can reply back into the UI.

## Step B — run Parley as a development channel

Parley is an MCP stdio server that declares `claude/channel`, so it loads exactly like any other
channel. Point a `.mcp.json` (or `--channels server:…`) entry at the built CLI with this config:

```jsonc
// .mcp.json
{
  "mcpServers": {
    "parley": {
      "command": "node",
      "args": [
        "packages/bridge-sqlite/dist/cli.js",
        "--config",
        "examples/fakechat-loopback/parley.config.yaml"
      ]
    }
  }
}
```

Then launch Claude Code loading Parley as a development channel (bypassing the preview allowlist):

```bash
claude --dangerously-load-development-channels --channels server:parley
```

> The exact `--channels` spec form for a local custom stdio server may evolve during the research
> preview — check `https://code.claude.com/docs/en/channels-reference` if `server:parley` is
> rejected. The startup notice tells you why a channel failed to register.

The config uses topic `ctx-demo`, handle `agent`, `live_push.enabled: true`, and a SQLite file
`./parley-demo.db`.

## Step C — drive the loop

From a second shell, post a message into `ctx-demo` as another participant (writing to the same
DB the running bridge polls). Quick way with a throwaway Node one-liner:

```bash
node --input-type=module -e '
import { SqlitePlugin } from "@parley/sqlite";
import { asHandle, asTopic } from "@parley/core";
const p = new SqlitePlugin();
await p.connect({ db_path: "./parley-demo.db" });
await p.post(asTopic("ctx-demo"), asHandle("human"), "ping from a human @agent — please ack");
await p.disconnect();
'
```

Confirm, in the running Claude Code session:

1. A `<channel source="parley" topic="ctx-demo" sender="human" msg_id=… cursor=… mentions="agent">`
   event arrives unprompted, carrying `ping from a human @agent — please ack`.
2. Ask Claude to reply; it calls **`parley_reply`** with `topic: "ctx-demo"`.
3. The reply is durable — verify it landed in the backend:

```bash
node --input-type=module -e '
import { SqlitePlugin } from "@parley/sqlite";
import { asTopic } from "@parley/core";
const p = new SqlitePlugin();
await p.connect({ db_path: "./parley-demo.db" });
const { messages } = await p.fetchRecent({ topic: asTopic("ctx-demo") });
console.log(messages.map(m => `${m.cursor} ${m.senderHandle}: ${m.content}`).join("\n"));
await p.disconnect();
'
```

You should see both the human's message and the agent's reply, each with a monotonic cursor.

## Pass criteria

- [ ] Step A: official fakechat delivers `<channel>` events and replies work.
- [ ] Step B: Parley registers as a channel (no error in the startup notice).
- [ ] Step C.1: a `<channel source="parley" …>` event arrives with identifier-keyed attributes.
- [ ] Step C.2: Claude replies via `parley_reply`.
- [ ] Step C.3: the reply is durable in the SQLite backend.
