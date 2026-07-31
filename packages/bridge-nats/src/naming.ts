import { safeName, type Topic } from '@sharptrick/parley-core';

export const MAX_STREAM_NAME_BYTES = 255; // JetStream's own cap on a stream name

// Subject tokens may not contain `.`, `*`, `>`, whitespace or a control character; stream names
// also bar `/ \`. Keep the control range folded here as well as rejected in `validatePrefix`, so
// that a topic — which a caller names through `post_topics`, unlike a prefix an operator writes —
// cannot compose a name the JetStream API answers with an unparseable frame.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s\u0000-\u001f\u007f]/g, '_');
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s\u0000-\u001f\u007f]/g, '_');

export const subjectFor = (prefix: string, topic: Topic): string =>
  prefix + safeName(topic, sanitizeToken);

export function streamNameFor(prefix: string, topic: Topic): string {
  const name = prefix + safeName(topic, sanitizeName);
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > MAX_STREAM_NAME_BYTES) {
    throw new Error(
      `nats stream name ${JSON.stringify(name)} is ${bytes} bytes, over JetStream's limit of ${MAX_STREAM_NAME_BYTES} — shorten the topic ${JSON.stringify(String(topic))} or stream_prefix ${JSON.stringify(prefix)}`,
    );
  }
  return name;
}

/** NATS subject interest: `*` matches exactly one token, `>` one or more trailing tokens. */
export function captures(pattern: string, subject: string): boolean {
  const tokens = pattern.split('.');
  const target = subject.split('.');
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '>') return target.length > i;
    if (i >= target.length) return false;
    if (tokens[i] !== '*' && tokens[i] !== target[i]) return false;
  }
  return tokens.length === target.length;
}

/**
 * The stream a topic maps to must carry that topic's subject. A stream that does not is a bridge
 * pointed at the wrong place, not an empty topic — refuse on EVERY path that meets one, so that a
 * read cannot answer "nothing here" forever while the messages sit under another prefix.
 */
export function assertCaptures(name: string, subject: string, subjects: string[]): void {
  if (subjects.some((pattern) => captures(pattern, subject))) return;
  throw new Error(
    `nats stream ${name} already exists capturing ${JSON.stringify(subjects)}, which does not include ${JSON.stringify(subject)} — subject_prefix or stream_prefix differs from the instance that created it`,
  );
}
