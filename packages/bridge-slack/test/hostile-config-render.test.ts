import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, resolveConfig, type SlackBackendConfig } from '../src/config.js';

expectLabelledRefusal('slack', {
  label: (key) => new RegExp(`^Slack (backend_config\\.)?${key}\\b`),
  keys: ['api_url', 'bot_token', 'app_token', 'handshake_timeout_ms', 'rotation_grace_ms'],
  mapKeys: ['channel_map', 'mention_map'],
  declared: CONFIG_KEYS.keys,
  credentialKeys: { bot_token: boxedSecret(), app_token: boxedSecret() },
  validate: (key, value) => void resolveConfig({ [key]: value } as SlackBackendConfig),
});
