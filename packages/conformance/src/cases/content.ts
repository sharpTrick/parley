/**
 * The payload shapes a real chat message takes and a test vocabulary does not. ONE table, read by
 * the write path (`post` either round-trips each of these or refuses it) and by the live floor
 * (each of them reaches a subscriber), so a shape added here is graded on BOTH paths rather than on
 * whichever one it was added for. Every live case used to write `[a-z][0-9a-z]{0,8}`, so a plugin
 * that dropped anything longer than a token, anything non-ASCII, or anything carrying a newline
 * passed all 34 cases while delivering nothing a deployment sends.
 *
 * Carriage return is not a row YET: an XMPP body is XML character data, whose parser normalizes CR
 * to LF before any plugin sees it, so no plugin can round-trip one — but refusing it is the arm the
 * write clause already permits, and bridge-xmpp accepts a CR and stores an LF. Add the row when
 * that plugin refuses; adding it first only reddens the backend.
 */
export const CONTENT_SHAPES: ReadonlyArray<readonly [label: string, body: string]> = [
  ['a newline', 'fidelity\nsecond line'],
  ['leading and trailing spaces', '  fidelity  '],
  ['an astral emoji', 'fidelity \u{1F600} done'],
  ['a combining sequence', 'fidelity e\u0301 vs \u00E9'],
  ['a tab', 'fidelity\tcolumn'],
  [
    'a sentence longer than any token this suite draws',
    'fidelity: a message the length a person writes, past any frame cap or fixed read buffer a ' +
      'plugin might have sized for the eight-character payloads every other case here sends.',
  ],
] as const;

/**
 * The longest payload every other case is content to send. A live path that drops anything longer
 * — a websocket frame cap, a fixed read buffer — is invisible to a suite whose messages are all
 * shorter, so the death row built on it is placed against this figure rather than against a number
 * chosen to make a table pass.
 */
export const SHORT_PAYLOAD = 40;

/** True when `text` is nothing but printable ASCII — what a drawn token always is, and no more. */
export const isPlainAscii = (text: string): boolean => !/[^\x20-\x7e]/.test(text);

/** True when `text` carries a control character: the newline and tab rows of the table above. */
export const carriesControlCharacter = (text: string): boolean => /[\x00-\x1f]/.test(text);
