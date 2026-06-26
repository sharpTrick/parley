// @parley/core — the transport-agnostic seam, normalized Message, cursor/dedup engine,
// and dual-role MCP channel server. ZERO backend dependencies (CLAUDE.md prime directive #1).
//
// Public surface is assembled here as each piece lands.
export const CORE_VERSION = '0.1.0';

// The seam + normalized Message (DESIGN §4/§5/§6).
export type { Topic, Handle, BackendMsgId, Cursor, Message } from './message.js';
export { asTopic, asHandle, asBackendMsgId, asCursor } from './message.js';
export type {
  BackendPlugin,
  BackendConfig,
  BackendIdentity,
  FetchRecentArgs,
  FetchRecentResult,
  MessageHandler,
} from './seam.js';

// Shared helpers (used by plugins and core alike).
export { parseMentions } from './mentions.js';

// Config (DESIGN §11).
export {
  ConfigSchema,
  type ParleyConfig,
  parseConfig,
  loadConfig,
  instanceIdOf,
} from './config.js';

// Security: topic allowlist (DESIGN §14).
export { Allowlist, TopicNotAllowedError } from './allowlist.js';

// Engine: dedup / ordering / catch-up / read-state (DESIGN §6/§7).
export { SeenSet } from './engine/seen-set.js';
export { ReadStateStore, defaultReadStatePath } from './engine/read-state.js';
export { catchUpTopic, catchUpAll, type CatchUpArgs } from './engine/catchup.js';

// Transport: reactive MCP tools (DESIGN §8/§9) + the dual-role channel server (push half).
export { registerTools, buildToolDefs, type ToolDeps } from './transport/tools.js';
export {
  emitChannel,
  channelMeta,
  CHANNEL_NOTIFICATION_METHOD,
} from './transport/channel-emit.js';
export { startPushLoop, type PushLoopOptions } from './transport/push-loop.js';
export {
  buildBridge,
  createStdioBridge,
  type ParleyBridge,
} from './transport/stdio-bridge.js';
// Remote mode (v0.2): Streamable-HTTP transport over the same seam (DESIGN §10).
export {
  buildReactiveServer,
  createRemoteHttpApp,
  type RemoteHttpServer,
  type RemoteHttpOptions,
} from './transport/http.js';
