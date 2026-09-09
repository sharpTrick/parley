import { describe, expect, it } from 'vitest';
import { delay } from '@sharptrick/parley-net-util';

describe('delay', () => {
  it('resolves after roughly the requested time', async () => {
    const started = Date.now();
    await delay(25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('resolves immediately for 0', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });
});
