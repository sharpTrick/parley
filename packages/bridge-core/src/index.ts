// @parley/core — the transport-agnostic seam, normalized Message, cursor/dedup engine,
// and dual-role MCP channel server. ZERO backend dependencies (CLAUDE.md prime directive #1).
//
// Public surface is assembled here as each piece lands.
export const CORE_VERSION = '0.1.0';

// The seam + normalized Message (DESIGN §4/§5/§6).
export type {
  Topic,
  Handle,
  BackendMsgId,
  Cursor,
  Message,
} from './message.js';
export { asTopic, asHandle, asBackendMsgId, asCursor } from './message.js';

export type {
  BackendPlugin,
  BackendConfig,
  BackendIdentity,
  FetchRecentArgs,
  FetchRecentResult,
  MessageHandler,
} from './seam.js';
