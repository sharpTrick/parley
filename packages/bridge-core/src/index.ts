// @sharptrick/parley-core — the transport-agnostic seam, normalized Message, cursor/dedup engine,
// and dual-role MCP channel server. ZERO backend dependencies (CLAUDE.md prime directive #1).
//
// Public surface is assembled here as each piece lands.
export { CORE_VERSION } from './version.js';

// The seam + normalized Message (DESIGN §4/§5/§6).
export type { Topic, Handle, BackendMsgId, Cursor, Message, BuildMessageInput } from './message.js';
export { asTopic, asHandle, asBackendMsgId, asCursor, buildMessage } from './message.js';
export { safeName, MIN_HASH_LEN, DEFAULT_HASH_LEN, MAX_HASH_LEN } from './topic-name.js';
export type {
  BackendPlugin,
  BackendConfig,
  BackendIdentity,
  FetchRecentArgs,
  FetchRecentResult,
  MessageHandler,
} from './seam.js';
export { NoSuchTopicError } from './seam.js';
export { isNoSuchTopicError } from './no-such-topic.js';

// Shared helpers (used by plugins and core alike).
export { parseMentions } from './mentions.js';

// Config (DESIGN §11).
export {
  ConfigSchema,
  AuthSchema,
  OidcAuthSchema,
  type ParleyConfig,
  type AuthConfig,
  type OidcAuthConfig,
  parseConfig,
  loadConfig,
  instanceIdOf,
  MAX_BLOCK_MS,
} from './config.js';

// Security: topic allowlist (DESIGN §14).
export {
  Allowlist,
  allowlistFor,
  TopicNotAllowedError,
  UnsafePatternError,
  type AllowlistOptions,
} from './allowlist.js';

// Engine: dedup / ordering / catch-up / read-state (DESIGN §6/§7).
export { SeenSet } from './engine/seen-set.js';
export { ReadStateStore, defaultReadStatePath } from './engine/read-state.js';
export { catchUpTopic, catchUpAll, type CatchUpArgs } from './engine/catchup.js';
export {
  fetchRecentBlocking,
  FetchAbortedError,
  isFetchAbortedError,
  type BlockingFetchOptions,
} from './engine/blocking-fetch.js';
// Presence: the reachability roster derived above the seam via hello/heartbeat/goodbye (DESIGN §7).
// Only the topic default is public — the roster is assembled behind `parley_list_users`, so the
// record/entry types would ship with no way to build, read or hand one back.
export { DEFAULT_PRESENCE_TOPIC } from './engine/presence.js';

// Transport: reactive MCP tools (DESIGN §8/§9) + the dual-role channel server (push half).
export { registerTools, toolDepsFor, TOOL_TEXT, type ToolDeps } from './transport/tools.js';
// The one entrypoint every backend `bin` runs: argv, config, bridge, teardown. The plugin arrives
// as an argument, so nothing here depends on a backend.
export {
  installShutdown,
  parseArgs,
  runBackendCli,
  usageFor,
  type BackendCliOptions,
  type ParseArgsOptions,
  type ParsedArgs,
  type ShutdownHost,
} from './cli/backend-cli.js';
export {
  emitChannel,
  channelMeta,
  CHANNEL_NOTIFICATION_METHOD,
} from './transport/channel-emit.js';
export { startPushLoop, type PushLoopOptions } from './transport/push-loop.js';
export {
  startPresenceLoop,
  type PresenceLoop,
  type PresenceLoopOptions,
} from './transport/presence-loop.js';
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
// Remote mode auth: single-tenant OAuth 2.1 + PKCE front door (DESIGN §10/§14).
export {
  createOAuthRemoteApp,
  type OAuthRemoteOptions,
  type OAuthRemoteServer,
} from './auth/remote.js';
export {
  ParleyOAuthProvider,
  ConsentError,
  type ParleyOAuthProviderOptions,
} from './auth/oauth-provider.js';
export { hashOwnerSecret, makeOwnerVerifier, ownerVerifierFromPassphrase } from './auth/owner.js';
// Remote mode auth, external-OIDC variant (e.g. Keycloak): delegated resource server (RFC 9728) —
// the IdP hosts the AS; Parley only publishes resource metadata and validates JWTs locally.
export {
  createOidcRemoteApp,
  type OidcRemoteOptions,
  type OidcRemoteServer,
} from './auth/oidc-remote.js';
export { OidcTokenVerifier, type OidcVerifierOptions } from './auth/oidc-verifier.js';
export { fetchOidcDiscovery } from './auth/oidc-discovery.js';
// The mode selector driven by cfg.auth (builtin | oidc).
export {
  createRemoteAuthApp,
  type RemoteAuthOptions,
  type RemoteAuthServer,
} from './auth/remote-auth.js';

// A fake OIDC issuer, for wiring an external-IdP deployment up in a test without one. It ships in
// the tarball either way (`src/testing` is compiled, only `*.test.ts` is excluded); named here so
// that reaching it does not mean a relative path into this package's `src/`, which pins a consumer
// to core's internal layout.
export { startFakeOidc, type FakeOidc, type FakeOidcClaims } from './testing/fake-oidc.js';
