import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, validateBackendConfig } from '../src/config.js';

expectLabelledRefusal('postgres', {
  label: (key) => new RegExp(`^parley-postgres: invalid backend_config\\.${key} `),
  keys: ['url', 'table_name', 'pool_size', 'retention_days'],
  declared: CONFIG_KEYS.keys,
  validate: (key, value) => void validateBackendConfig({ [key]: value }),
});
