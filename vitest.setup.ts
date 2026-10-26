import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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

// ONE directory per WORKER, reused by every file that worker runs, rather than one per file.
// Under an interrupted run the per-file version compounds without bound: a batch that lost its
// parent left ~300,000 of these behind and exhausted the tmpfs INODE table (1.0M of them), at which
// point every open on the box failed with ENOSPC while `df -h` still reported 8.3G free. A storm of
// collection failures now costs one directory per worker instead of one per file.
const worker = process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID || '0';
const sandbox = join(tmpdir(), `${PREFIX}${process.pid}-${worker}`);
process.env.XDG_STATE_HOME = join(sandbox, 'state');
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
