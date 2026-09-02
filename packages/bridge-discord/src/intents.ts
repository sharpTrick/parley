/**
 * Gateway intents this plugin cannot work without. MESSAGE_CONTENT is PRIVILEGED and must also be
 * toggled on in the developer portal; without it every `MESSAGE_CREATE` arrives with empty
 * `content`. Keep this list matching `test/discord-intents.ts`, which restates Discord's bits by
 * value and is what the fakes demand, so that dropping one here is a refused handshake in the
 * suite rather than a bridge that reaches READY and is never dispatched a message.
 */
export const REQUIRED_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,
} as const;

/** The packed bitfield sent on IDENTIFY. */
export const INTENTS = Object.values(REQUIRED_INTENTS).reduce((bits, bit) => bits | bit, 0);
