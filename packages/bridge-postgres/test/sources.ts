import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/**
 * Every `src/**` file's text, concatenated. Keep the rules that grade the code reading THIS, so
 * that moving what one of them counts into another file cannot silence it.
 */
export const SOURCE = walk(fileURLToPath(new URL('../src/', import.meta.url)))
  .sort()
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
