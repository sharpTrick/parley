import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { validateBackendConfig } from '../src/config.js';

expectLabelledRefusal('postgres', {
  label: (key) => new RegExp(`^parley-postgres: invalid backend_config\\.${key} `),
  keys: ['url', 'table_name', 'pool_size', 'retention_days'],
  credentialKeys: ['url'],
  textKeys: ['pool_size', 'retention_days'],
  validate: (key, value) => void validateBackendConfig({ [key]: value }),
});
