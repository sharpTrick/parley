/**
 * Discord's own gateway intent bits, restated as LITERALS from
 * https://discord.com/developers/docs/events/gateway#gateway-intents, and the set an IDENTIFY from
 * this plugin has to carry. Keep the fakes and the wire table reading THIS rather than the plugin's
 * `REQUIRED_INTENTS`, so that a bit dropped from the plugin's list is a refused handshake and a
 * failed row instead of a requirement that disappears along with it: every fake enforcing the list
 * it is grading agrees with any list at all, including one that receives no MESSAGE_CREATE.
 */
export const GATEWAY_INTENT_BITS = {
  GUILDS: 1,
  /** Without it Discord dispatches no MESSAGE_CREATE, and every long-poll blocks its budget. */
  GUILD_MESSAGES: 512,
  /** PRIVILEGED, and also toggled in the developer portal; without it `content` arrives empty. */
  MESSAGE_CONTENT: 32768,
} as const;

/** The bits a compliant IDENTIFY must set, in the packed form Discord reads them in. */
export const REQUIRED_INTENT_BITS: readonly number[] = Object.values(GATEWAY_INTENT_BITS);

/**
 * The EXACT bitfield expected on the wire. A privileged intent this plugin does not need is not
 * free: Discord closes 4014 on one that is not enabled in the portal, and no fake refusing only
 * MISSING bits can see an added one.
 */
export const EXPECTED_INTENT_MASK = REQUIRED_INTENT_BITS.reduce((bits, bit) => bits | bit, 0);
