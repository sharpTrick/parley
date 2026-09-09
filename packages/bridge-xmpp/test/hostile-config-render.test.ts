import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, validateBackendConfig } from '../src/config.js';

expectLabelledRefusal('xmpp', {
  label: (key) => new RegExp(`^parley-xmpp: invalid backend_config\\.${key} `),
  keys: CONFIG_KEYS.map(String),
  declared: CONFIG_KEYS.map(String),
  credentialKeys: { password: boxedSecret(), service: boxedSecret() },
  validate: (key, value) => void validateBackendConfig({ [key]: value }),
});
