import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import {
  assertKnownBackendConfig,
  CONFIG_KEYS,
  requireNumericKnobs,
  type TelegramBackendConfig,
} from '../src/config.js';

const KNOBS = [
  'poll_timeout_s',
  'observed_retention_per_chat',
  'observed_retention_per_topic',
  'observed_max_chats',
];

expectLabelledRefusal('telegram', {
  label: (key) => new RegExp(`^TelegramPlugin: backend_config\\.${key} `),
  keys: KNOBS,
  declared: CONFIG_KEYS.keys,
  ungraded: {
    token: {
      reason: 'refused by shape nowhere: a non-string token reaches the Bot API as one',
      accepts: 42,
    },
    api_url: {
      reason:
        'refused by shape nowhere in the config path; a non-string fails later at connect with a ' +
        'bare unlabelled TypeError. Pre-existing debt, carried, not this chunk',
      accepts: 42,
    },
    store_path: {
      reason:
        'refused by shape nowhere in the config path; a non-string fails later at first write ' +
        'with a bare unlabelled TypeError. Pre-existing debt, carried, not this chunk',
      accepts: 42,
    },
    chat_map: {
      reason:
        'a wrong-typed map is ACCEPTED and every topic is then used as a literal chat id; carried ' +
        'as pre-existing debt, not this chunk',
      accepts: 42,
    },
  },
  validate: (key, value) => {
    assertKnownBackendConfig({ [key]: value });
    requireNumericKnobs({ [key]: value } as unknown as TelegramBackendConfig);
  },
});
