import type { Message } from './message.js';
import type { MessageHandler } from './seam.js';

/**
 * Hand one message to the handler, absorbing BOTH ways it can fail. Keep the throw arm, so that one
 * message a handler chokes on does not end live delivery for the topic behind a `subscribe()` that
 * already resolved — silently, since catch-up keeps working and nothing writes a line. Keep the
 * REJECTION arm too, so that an `async` handler — which the `=> void` return type of
 * {@link MessageHandler} does not forbid, and which core is free to pass — cannot take the whole
 * bridge down with an unhandled rejection on Node's default `--unhandled-rejections=throw`.
 *
 * The message arrives as a THUNK, so that BUILDING it is inside the containment too: inbound is
 * untrusted (CLAUDE.md), and a wire record a plugin's own converter chokes on would otherwise throw
 * from the call site — out through the socket-level catch that ends the connection, taking live
 * delivery for every subscription with it.
 */
export function safeDeliver(handler: MessageHandler, message: () => Message): void {
  try {
    void Promise.resolve(handler(message())).catch(() => undefined);
  } catch {
    /* neither the handler's failure nor the converter's is the live path's */
  }
}
