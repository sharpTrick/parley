import { chmodSync, closeSync, openSync, statSync } from 'node:fs';
import { errMessage } from './classify.js';

/**
 * Claim the path at 0600 before anything else can create it. Stay silent on failure, so that a
 * bad path or a permissions problem surfaces the driver's own precise open error below rather
 * than this one.
 */
export function precreate(path: string): void {
  try {
    closeSync(openSync(path, 'a', 0o600));
  } catch {
    /* the open below reports it */
  }
}

/** Narrow a file that is readable beyond its owner, reporting both the change and any failure. */
export function restrictMode(path: string): void {
  let current: number;
  try {
    current = statSync(path).mode & 0o777;
  } catch {
    return; // sidecar not created yet
  }
  if ((current & 0o077) === 0) return;
  const target = current & 0o700;
  try {
    chmodSync(path, target);
    process.stderr.write(
      `parley-sqlite: tightened ${path} from 0${current.toString(8)} to 0${target.toString(8)} ` +
        `(the message store must not be readable by other accounts)\n`,
    );
  } catch (e) {
    process.stderr.write(
      `parley-sqlite: cannot restrict ${path} (mode 0${current.toString(8)}, ${errMessage(e)}) — ` +
        `the message store is readable by other accounts on this host\n`,
    );
  }
}
