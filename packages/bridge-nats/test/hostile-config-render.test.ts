import { boxedSecret, expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { MAX_STREAM_NAME_BYTES } from '../src/naming.js';
import { DECLARED, validatePrefix, validateRetentionMaxAgeNs } from '../src/config.js';

const VALIDATORS: Record<string, (value: unknown) => void> = {
  subject_prefix: (value) =>
    void validatePrefix('subject_prefix', value as string, 'parley.', /[*>\s]/),
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

expectLabelledRefusal('nats', {
  label: (key) => new RegExp(`^invalid ${key} `),
  keys: Object.keys(VALIDATORS),
  declared: DECLARED.keys,
  ungraded: {
    servers:
      'graded by assertNoServerCredentials, which names the field and never the value, and by ' +
      'plaintextCredentialRisks — neither is a shape refusal',
    tls: 'a nested group; assertKnownBackendConfig refuses a non-string member, naming its type',
    token: 'spent as a credential and never rendered: nothing about it is refused on shape',
    user: 'spent as a credential and never rendered: nothing about it is refused on shape',
    pass: 'spent as a credential and never rendered: nothing about it is refused on shape',
    creds_file: 'a path read at connect: the driver, not this plugin, refuses an unusable one',
    nkey_seed: 'spent as a credential and never rendered: nothing about it is refused on shape',
  },
  accepts: {
    subject_prefix: [
      'a RIGHT-TO-LEFT OVERRIDE (U+202E)',
      '4KiB of one character',
      '4KiB carrying a bidi override',
    ],
    stream_prefix: ['a RIGHT-TO-LEFT OVERRIDE (U+202E)'],
  },
  credentialKeys: { subject_prefix: boxedSecret(), stream_prefix: boxedSecret() },
  textKeys: ['subject_prefix', 'stream_prefix', 'retention_days'],
  validate: (key, value) => {
    (VALIDATORS[key] as (v: unknown) => void)(value);
  },
});
