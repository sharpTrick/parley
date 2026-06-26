import type {
  BackendConfig,
  BackendIdentity,
  BackendMsgId,
  BackendPlugin,
  FetchRecentArgs,
  FetchRecentResult,
  Handle,
  MessageHandler,
  Topic,
} from '@parley/core';

const NOT_YET = '@parley/matrix: not implemented yet (planned v0.4)';

/**
 * @parley/matrix — first external-network backend (matrix-js-sdk: room->topic, sync token->cursor, sync loop->subscribe, history->fetchRecent).
 *
 * Skeleton ONLY: implements the frozen seam with not-yet-implemented methods so the package
 * compiles against @parley/core. Filling these in must touch ONLY this package — never
 * @parley/core (the seam-stays-additive success criterion). Run the shared @parley/conformance
 * suite against it when implemented.
 */
export class MatrixPlugin implements BackendPlugin {
  async connect(_config: BackendConfig): Promise<void> {
    throw new Error(NOT_YET);
  }
  async disconnect(): Promise<void> {
    throw new Error(NOT_YET);
  }
  async subscribe(_topic: Topic, _handler: MessageHandler): Promise<void> {
    throw new Error(NOT_YET);
  }
  async post(
    _topic: Topic,
    _identity: Handle,
    _content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    throw new Error(NOT_YET);
  }
  async fetchRecent(_args: FetchRecentArgs): Promise<FetchRecentResult> {
    throw new Error(NOT_YET);
  }
  async resolveIdentity(_handle: Handle): Promise<BackendIdentity> {
    throw new Error(NOT_YET);
  }
}
