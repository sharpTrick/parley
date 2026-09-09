import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, requireNumericKnobs, type TelegramBackendConfig } from '../src/config.js';

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
    token: 'refused by shape nowhere: a non-string token reaches the Bot API as one',
    api_url: 'produces a bare unlabelled TypeError; carried as pre-existing debt, not this chunk',
    store_path: 'produces a bare unlabelled TypeError; carried as pre-existing debt, not this chunk',
    chat_map:
      'a wrong-typed map is ACCEPTED and every topic is then used as a literal chat id; carried ' +
      'as pre-existing debt, not this chunk',
  },
  validate: (key, value) =>
    void requireNumericKnobs({ [key]: value } as unknown as TelegramBackendConfig),
});
