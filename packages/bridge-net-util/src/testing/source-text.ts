/**
 * CLASS: a text scan that cannot tell code from prose. Six independent comment strippers were in the
 * tree and the difference between them was the difference between a live guard and a dead one — a
 * rule graded over source INCLUDING comments turns red to green the moment somebody writes a
 * sentence naming the symbol, which under this repository's comment doctrine is the cheapest
 * artifact available. One state machine, self-tested against the shapes that separate the two.
 */

/** String, template and regex-ish literals, each required to close on the line it opens. */
const LITERALS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;

/**
 * The line with every literal blanked to same-length filler, so `//` inside a URL or a fixture that
 * quotes a comment is not read as one.
 *
 * Keep each literal closing on the line it opens: an unpaired quote inside a regex literal must
 * match nothing rather than swallow the code down to the next real quote — that runaway is silent,
 * spans lines, and reports offences the file never wrote.
 */
const masked = (line: string): string => line.replace(LITERALS, (m) => m[0]!.repeat(m.length));

interface Split {
  code: string;
  comment: string;
  inBlock: boolean;
}

/** One line cut into the code half and the commentary half, with block state threaded through. */
function splitLine(line: string, inBlock: boolean): Split {
  const mask = masked(line);
  if (inBlock) {
    const end = mask.indexOf('*/');
    if (end < 0) return { code: '', comment: line, inBlock: true };
    const rest = splitLine(line.slice(end + 2), false);
    return { code: rest.code, comment: line.slice(0, end + 2) + rest.comment, inBlock: rest.inBlock };
  }
  const lineAt = mask.indexOf('//');
  const blockAt = mask.indexOf('/*');
  if (blockAt >= 0 && (lineAt < 0 || blockAt < lineAt)) {
    const close = mask.indexOf('*/', blockAt + 2);
    if (close < 0) return { code: line.slice(0, blockAt), comment: line.slice(blockAt), inBlock: true };
    const rest = splitLine(line.slice(close + 2), false);
    return {
      code: line.slice(0, blockAt) + rest.code,
      comment: line.slice(blockAt, close + 2) + rest.comment,
      inBlock: rest.inBlock,
    };
  }
  if (lineAt >= 0) return { code: line.slice(0, lineAt), comment: line.slice(lineAt), inBlock: false };
  return { code: line, comment: '', inBlock: false };
}

function split(source: string): Split[] {
  let inBlock = false;
  return source.split('\n').map((line) => {
    const seen = splitLine(line, inBlock);
    inBlock = seen.inBlock;
    return seen;
  });
}

/** `source` with comments removed, line for line, and everything else left where it was. */
export const withoutComments = (source: string): string =>
  split(source).map((s) => s.code).join('\n');

/** `source` reduced to the code a rule may judge: comments gone and every literal blanked. */
export const codeOf = (source: string): string =>
  split(source).map((s) => masked(s.code)).join('\n');

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
