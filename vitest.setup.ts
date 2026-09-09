import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Keep the suite out of the developer's real state directory, so that running `vitest` cannot read
 * or advance a position a person's actual bridge wrote.
 *
 * `state_path` is optional and falls back to `${XDG_STATE_HOME:-~/.local/state}/parley/<instance>/`.
 * A test that omits it therefore opens the REAL file. Measured on a maintainer's box: a stale
 * `{"ctx":"5"}` at ~/.local/state/parley/agent/read-state.json made one stdio-bridge lifecycle case
 * count two `fetchRecent` calls instead of one, and the suite had left a `read-state.json.warmed`
 * beside it. Twelve test files built a config naming neither `state_path` nor `XDG_STATE_HOME`;
 * three remembered to redirect. Remembering is what failed, so this is global.
 *
 * One fresh directory per test file, so nothing survives into the next run either.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'parley-xdg-'));
process.env.XDG_STATE_HOME = join(sandbox, 'state');

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
