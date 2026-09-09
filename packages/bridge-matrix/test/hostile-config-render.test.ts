import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { CONFIG_KEYS, validateConfig, type MatrixBackendConfig } from '../src/config.js';

expectLabelledRefusal('matrix', {
  label: (key) => new RegExp(`^\\[parley-matrix\\] backend_config\\.${key} `),
  keys: [
    'homeserver_url',
    'user',
    'password',
    'server_name',
    'shared_room',
    'sync_timeout_ms',
    'invite',
    'room_preset',
  ],
  declared: CONFIG_KEYS.keys,
  accepts: { invite: ['an array'] },
  credentialKeys: { password: boxedSecret(), homeserver_url: boxedSecret() },
  textKeys: ['sync_timeout_ms', 'room_preset'],
  validate: (key, value) => void validateConfig({ [key]: value } as MatrixBackendConfig),
});
