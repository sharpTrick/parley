import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, type RedisBackendConfig, resolveConfig } from '../src/config.js';

expectLabelledRefusal('redis', {
  label: (key) => new RegExp(`^parley-redis: .*\\b${key}\\b`),
  keys: CONFIG_KEYS.map(String),
  declared: CONFIG_KEYS.map(String),
  credentialKeys: { url: boxedSecret() },
  textKeys: ['block_ms', 'connect_timeout_ms', 'retention_days'],
  validate: (key, value) => void resolveConfig({ [key]: value } as RedisBackendConfig),
});
