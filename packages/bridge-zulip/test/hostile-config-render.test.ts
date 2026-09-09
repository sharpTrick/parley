import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, resolveConfig } from '../src/config.js';

expectLabelledRefusal('zulip', {
  label: (key) => new RegExp(`^backend_config\\.${key} `),
  keys: ['site_url', 'email', 'api_key', 'stream', 'events_timeout_ms'],
  declared: CONFIG_KEYS.keys,
  credentialKeys: { api_key: boxedSecret(), site_url: boxedSecret() },
  textKeys: ['events_timeout_ms'],
  validate: (key, value) => void resolveConfig({ [key]: value }),
});
