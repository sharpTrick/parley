import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, type RedisBackendConfig, resolveConfig } from '../src/config.js';

expectLabelledRefusal('redis', {
  label: (key) => new RegExp(`^parley-redis: .*\\b${key}\\b`),
  keys: CONFIG_KEYS.map(String),
  declared: CONFIG_KEYS.map(String),
  validate: (key, value) => void resolveConfig({ [key]: value } as RedisBackendConfig),
});
