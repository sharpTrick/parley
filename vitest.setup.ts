import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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
const PREFIX = 'parley-xdg-';
/** How long a leaked sandbox survives before the next run collects it. Far longer than any run. */
const KEEP_FOR_MS = 6 * 60 * 60 * 1000;

// The `afterAll` below never runs for a file that fails to COLLECT, and each such file leaves its
// sandbox behind: 81 empty ones accumulated here in 29 minutes of a round that was reddening
// collection. Sweep the ones no run can still be holding, so a leak costs one stale directory
// rather than one per failure for as long as the box lives.
for (const entry of readdirSync(tmpdir())) {
  if (!entry.startsWith(PREFIX)) continue;
  const path = join(tmpdir(), entry);
  try {
    if (Date.now() - statSync(path).mtimeMs > KEEP_FOR_MS) rmSync(path, { recursive: true, force: true });
  } catch {
    // Another run is holding it, or it is already gone.
  }
}

const sandbox = mkdtempSync(join(tmpdir(), PREFIX));
process.env.XDG_STATE_HOME = join(sandbox, 'state');

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
