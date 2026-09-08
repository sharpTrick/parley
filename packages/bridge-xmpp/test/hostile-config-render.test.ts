import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, validateBackendConfig } from '../src/config.js';

expectLabelledRefusal('xmpp', {
  label: (key) => new RegExp(`^parley-xmpp: invalid backend_config\\.${key} `),
  keys: CONFIG_KEYS.map(String),
  credentialKeys: ['password'],
  textKeys: ['mam_page'],
  validate: (key, value) => void validateBackendConfig({ [key]: value }),
});
