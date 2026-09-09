import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, validateBackendConfig } from '../src/config.js';

expectLabelledRefusal('postgres', {
  label: (key) => new RegExp(`^parley-postgres: invalid backend_config\\.${key} `),
  keys: ['url', 'table_name', 'pool_size', 'retention_days'],
  declared: CONFIG_KEYS.keys,
  credentialKeys: { url: boxedSecret() },
  textKeys: ['pool_size', 'retention_days'],
  validate: (key, value) => void validateBackendConfig({ [key]: value }),
});
