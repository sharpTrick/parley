import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { MAX_STREAM_NAME_BYTES, MAX_SUBJECT_BYTES } from '../src/naming.js';
import {
  assertKnownBackendConfig,
  DECLARED,
  validatePrefix,
  validateRetentionMaxAgeNs,
} from '../src/config.js';

const VALIDATORS: Record<string, (value: unknown) => void> = {
  subject_prefix: (value) =>
    void validatePrefix('subject_prefix', value as string, 'parley.', /[*>\s]/, MAX_SUBJECT_BYTES),
  stream_prefix: (value) =>
    void validatePrefix(
      'stream_prefix',
      value as string,
      'PARLEY_',
      /[.*>/\\\s]/,
      MAX_STREAM_NAME_BYTES,
    ),
  retention_days: (value) => void validateRetentionMaxAgeNs(value as number),
};

const SPENT_NOT_RENDERED =
  'spent as a credential and never rendered: nothing about it is refused on shape';

expectLabelledRefusal('nats', {
  label: (key) => new RegExp(`^parley-nats: invalid ${key} `),
  keys: Object.keys(VALIDATORS),
  declared: DECLARED.keys,
  ungraded: {
    servers: {
      reason:
        'no shape refusal to grade: every string is a candidate address. What DOES render it — ' +
        'assertNoServerCredentials and plaintextCredentialRisks — is crossed over the hostile ' +
        'corpus in config.test.ts, which is where the value reaches an operator',
      accepts: 'nats://127.0.0.1:4222',
    },
    tls: {
      reason: 'a nested group; assertKnownBackendConfig refuses a non-string member, naming its type',
      accepts: { ca_file: '/tmp/ca.pem' },
    },
    token: { reason: SPENT_NOT_RENDERED, accepts: 42 },
    user: { reason: SPENT_NOT_RENDERED, accepts: 42 },
    pass: { reason: SPENT_NOT_RENDERED, accepts: 42 },
    creds_file: {
      reason: 'a path read at connect: the driver, not this plugin, refuses an unusable one',
      accepts: '/no/such/file',
    },
    nkey_seed: { reason: SPENT_NOT_RENDERED, accepts: 42 },
  },
  accepts: {
    subject_prefix: ['a RIGHT-TO-LEFT OVERRIDE (U+202E)'],
    stream_prefix: ['a RIGHT-TO-LEFT OVERRIDE (U+202E)'],
  },
  credentialKeys: { subject_prefix: boxedSecret(), stream_prefix: boxedSecret() },
  // Route a key this spec has no shape validator for through the plugin's own key/nested check, so
  // that an `ungraded` witness is graded by the code that really runs rather than by a lookup miss.
  validate: (key, value) => {
    const validator = VALIDATORS[key];
    if (validator === undefined) assertKnownBackendConfig({ [key]: value });
    else validator(value);
  },
});
