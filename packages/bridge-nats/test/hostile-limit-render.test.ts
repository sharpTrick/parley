import { asTopic } from '@sharptrick/parley-core';
import { expectLabelledRefusal } from '@sharptrick/parley-net-util/testing';
import { normalizeLimit } from '../src/cursor.js';

expectLabelledRefusal('nats', {
  label: () => /^invalid nats limit /,
  keys: ['limit'],
  textKeys: ['limit'],
  validate: (_key, value) => void normalizeLimit(value as number, asTopic('room')),
});
