/**
 * Gateway intents this plugin cannot work without. MESSAGE_CONTENT is PRIVILEGED and must also be
 * toggled on in the developer portal; without it every `MESSAGE_CREATE` arrives with empty
 * `content`. Keep this module free of IMPORTS, so that the test fakes can enforce the bits without
 * pulling `ws` in through the plugin — `vi.mock('ws')` awaits the fakes, and a cycle deadlocks.
 */
export const REQUIRED_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,
} as const;

/** The packed bitfield sent on IDENTIFY. */
export const INTENTS = Object.values(REQUIRED_INTENTS).reduce((bits, bit) => bits | bit, 0);
