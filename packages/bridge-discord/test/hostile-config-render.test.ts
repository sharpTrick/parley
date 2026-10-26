import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { assertKnownBackendConfig, CONFIG_SHAPES } from '../src/config.js';

expectLabelledRefusal('discord', {
  label: (key) => new RegExp(`^Discord backend_config\\.${key} `),
  keys: ['token', 'api_url', 'gateway_url', 'handshake_timeout_ms', 'gateway_dialers'],
  mapKeys: ['channel_map'],
  declared: Object.keys(CONFIG_SHAPES),
  ungraded: {
    allowed_mentions: {
      reason:
        'a nested group: assertKnownConfigKeys grades the container and the member names, and ' +
        'every member is a boolean or an id list with no rendered refusal of its own',
      accepts: { parse: ['users'], replied_user: true },
    },
  },
  validate: (key, value) => void assertKnownBackendConfig({ [key]: value }),
});
