import { PERMANENT_CODES } from '../src/client.js';

// The permanent/transient split decides whether live delivery STOPS or is ridden out, so every code
// it can meet needs a declared verdict. The permanent side is generated from the shipped list, so a
// code added to the classifier is graded before it has a bug. The transient side is DECLARED here
// rather than derived from anything in src: a list the classifier supplies could only ever agree
// with the classifier, and it is a code moving into the permanent list — a `READONLY` across a
// replica failover, a `CLUSTERDOWN` mid-resharding — that kills live push for the life of the
// process.

/** What a real server puts after each code the classifier calls permanent. */
const PERMANENT_TEXT: Record<string, string> = {
  ERR: "unknown command 'PING'",
  NOAUTH: 'Authentication required.',
  WRONGPASS: 'invalid username-password pair or user is disabled.',
  NOPERM: "this user has no permissions to run the 'ping' command",
  WRONGTYPE: 'Operation against a key holding the wrong kind of value',
  NOPROTO: 'unsupported protocol version',
  EXECABORT: 'Transaction discarded because of previous errors.',
};

/** Every code the classifier treats as "only an operator can clear this", with its sample text. */
export const PERMANENT_REFUSALS: Array<[code: string, text: string]> = PERMANENT_CODES.map(
  (code) => [code, PERMANENT_TEXT[code] ?? ''],
);

/** A code the classifier ships that nothing here declares — a widening no row would grade. */
export const UNDECLARED_PERMANENT: string[] = PERMANENT_CODES.filter(
  (code) => (PERMANENT_TEXT[code] ?? '') === '',
);

/**
 * A code declared permanent that the classifier no longer ships — a narrowing, which is invisible
 * to every generated row above precisely because they are generated: dropping a code deletes its
 * rows instead of failing them, and live push then retries a refusal only an operator can clear.
 */
export const UNSHIPPED_PERMANENT: string[] = Object.keys(PERMANENT_TEXT).filter(
  (code) => !(PERMANENT_CODES as readonly string[]).includes(code),
);

/** Refusals a retry can clear on its own, which live delivery must ride out rather than retire on. */
export const TRANSIENT_REFUSALS: Array<[code: string, message: string]> = [
  ['LOADING', 'LOADING Redis is loading the dataset in memory'],
  ['MOVED', 'MOVED 3999 127.0.0.1:6381'],
  ['ASK', 'ASK 3999 127.0.0.1:6381'],
  ['READONLY', 'READONLY You can not write against a read only replica.'],
  ['BUSY', 'BUSY Redis is busy running a script.'],
  ['TRYAGAIN', 'TRYAGAIN Multiple keys request during rehashing of slot'],
  ['CLUSTERDOWN', 'CLUSTERDOWN Hash slot not served'],
  ['MASTERDOWN', 'MASTERDOWN Link with MASTER is down'],
  ['NOREPLICAS', 'NOREPLICAS Not enough good replicas to write'],
];

/** Codes declared both ways — a verdict the suite cannot hold and the classifier cannot honour. */
export const CONTRADICTED: string[] = TRANSIENT_REFUSALS.map(([code]) => code).filter((code) =>
  (PERMANENT_CODES as readonly string[]).includes(code),
);
