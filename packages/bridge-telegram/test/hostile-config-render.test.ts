import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { requireNumericKnobs, type TelegramBackendConfig } from '../src/config.js';

const KNOBS = [
  'poll_timeout_s',
  'observed_retention_per_chat',
  'observed_retention_per_topic',
  'observed_max_chats',
];

expectLabelledRefusal('telegram', {
  label: (key) => new RegExp(`^TelegramPlugin: backend_config\\.${key} `),
  keys: KNOBS,
  textKeys: KNOBS,
  validate: (key, value) =>
    void requireNumericKnobs({ [key]: value } as unknown as TelegramBackendConfig),
});
