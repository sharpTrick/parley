import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, validateBackendConfig } from '../src/config.js';

expectLabelledRefusal('sqlite', {
  label: (key) => new RegExp(`^parley-sqlite: invalid backend_config\\.${key} `),
  keys: ['db_path', 'poll_interval_ms', 'retention_days'],
  declared: CONFIG_KEYS.keys,
  credentialKeys: { db_path: boxedSecret() },
  validate: (key, value) => void validateBackendConfig({ [key]: value }),
});
