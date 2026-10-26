/**
 * CLASS: a text scan that cannot tell code from prose. Six independent comment strippers were in the
 * tree and the difference between them was the difference between a live guard and a dead one — a
 * rule graded over source INCLUDING comments turns red to green the moment somebody writes a
 * sentence naming the symbol, which under this repository's comment doctrine is the cheapest
 * artifact available. One state machine, self-tested against the shapes that separate the two.
 */

interface Split {
  code: string;
  masked: string;
  comment: string;
}

/** Where a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<',
  '>', '\n',
]);
const REGEX_AFTER_KEYWORD = /(?:^|\W)(?:return|typeof|instanceof|in|of|new|delete|do|else|case|yield|await|void)$/;

/**
 * One line cut into the code half, the same half with every literal blanked, and the commentary.
 *
 * One pass over the WHOLE file rather than a regex per line, so that a template spanning lines, a
 * regex holding a quote or a comment marker, and a comment inside a `${}` placeholder are each read
 * as what they are. A per-line matcher has to assume every literal closes on the line it opens: a
 * template carrying `/*` then swallowed the rest of the file, a regex carrying `//` truncated its
 * line, and a regex carrying a PAIR of quotes destroyed everything between them — including, live
 * in this repo, the argument-literal extractor the package-boundary rule is built on.
 */
function split(source: string): Split[] {
  const lines: Split[] = [{ code: '', masked: '', comment: '' }];
  const open = (): void => void lines.push({ code: '', masked: '', comment: '' });
  const here = (): Split => lines[lines.length - 1]!;

  /** Everything from `from` to `to` is one kind; a newline always ends the line it is on. */
  const paint = (from: number, to: number, kind: 'code' | 'comment', mask: string): void => {
    for (let at = from; at < to; at++) {
      const ch = source[at]!;
      if (ch === '\n') {
        open();
        continue;
      }
      if (kind === 'comment') here().comment += ch;
      else {
        here().code += ch;
        here().masked += mask === '' ? ch : mask;
      }
    }
  };

  /** Brace depth outside each `${}` placeholder we are inside, innermost last. */
  const placeholders: number[] = [];
  let inTemplate = false;
  let depth = 0;
  let before = '\n';
  let word = '';
  let at = 0;

  const closingQuote = (from: number, quote: string): number => {
    for (let k = from + 1; k < source.length; k++) {
      if (source[k] === '\\') k++;
      else if (source[k] === quote) return k + 1;
      else if (source[k] === '\n') return k;
    }
    return source.length;
  };

  /** Where a regex opened at `from` ends, or -1 when what follows is not one. */
  const closingSlash = (from: number): number => {
    let inClass = false;
    for (let k = from + 1; k < source.length; k++) {
      const ch = source[k]!;
      if (ch === '\\') k++;
      else if (ch === '\n') return -1;
      else if (inClass) inClass = ch !== ']';
      else if (ch === '[') inClass = true;
      else if (ch === '/') {
        let end = k + 1;
        while (end < source.length && /[a-z]/.test(source[end]!)) end++;
        return end;
      }
    }
    return -1;
  };

  while (at < source.length) {
    const ch = source[at]!;
    if (inTemplate) {
      if (ch === '\\') {
        paint(at, at + 2, 'code', '`');
        at += 2;
      } else if (ch === '`') {
        paint(at, at + 1, 'code', '`');
        inTemplate = false;
        before = '`';
        word = '';
        at++;
      } else if (ch === '$' && source[at + 1] === '{') {
        paint(at, at + 2, 'code', '`');
        placeholders.push(depth);
        depth = 0;
        inTemplate = false;
        before = '{';
        word = '';
        at += 2;
      } else {
        paint(at, at + 1, 'code', '`');
        at++;
      }
      continue;
    }

    const two = source.slice(at, at + 2);
    if (two === '//') {
      const nl = source.indexOf('\n', at);
      paint(at, nl < 0 ? source.length : nl, 'comment', '');
      at = nl < 0 ? source.length : nl;
      continue;
    }
    if (two === '/*') {
      const close = source.indexOf('*/', at + 2);
      const to = close < 0 ? source.length : close + 2;
      paint(at, to, 'comment', '');
      at = to;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const to = closingQuote(at, ch);
      paint(at, to, 'code', ch);
      at = to;
      before = ch;
      word = '';
      continue;
    }
    if (ch === '`') {
      paint(at, at + 1, 'code', '`');
      inTemplate = true;
      at++;
      continue;
    }
    if (ch === '/' && (REGEX_AFTER.has(before) || REGEX_AFTER_KEYWORD.test(word))) {
      const to = closingSlash(at);
      if (to > 0) {
        paint(at, to, 'code', '/');
        at = to;
        before = '/';
        word = '';
        continue;
      }
    }
    if (ch === '}' && depth === 0 && placeholders.length > 0) {
      paint(at, at + 1, 'code', '`');
      depth = placeholders.pop()!;
      inTemplate = true;
      at++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    paint(at, at + 1, 'code', '');
    if (!/[ \t\r]/.test(ch)) before = ch;
    word = /[\w$]/.test(ch) ? word + ch : '';
    at++;
  }
  return lines;
}

/** `source` with comments removed, line for line, and everything else left where it was. */
export const withoutComments = (source: string): string =>
  split(source)
    .map((s) => s.code)
    .join('\n');

/** `source` reduced to the code a rule may judge: comments gone and every literal blanked. */
export const codeOf = (source: string): string =>
  split(source)
    .map((s) => s.masked)
    .join('\n');

/**
 * The TITLE of a test declared on a line. A case name is the first thing a human reads when it
 * fails, so the comment rules govern it too.
 */
const TITLE = /^\s*(?:it|test|describe)(?:\.\w+)*(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:[^\\]|\\.)*?)\1/;

/** Every line's commentary and test name, with block state threaded through as the lints see it. */
export const commentaryLines = (source: string): string[] =>
  split(source).map(({ code, comment }, at) => {
    const title = TITLE.exec(source.split('\n')[at] ?? '')?.[2] ?? '';
    return `${title} ${comment}`.trim() === '' && code.trim().startsWith('*')
      ? code.trim()
      : `${title} ${comment}`;
  });
