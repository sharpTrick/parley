/**
 * Who a Zulip mention names is read from the realm's members, and read again only when a message
 * names someone the last read did not have — never more than once per refresh interval, so a name
 * nobody has cannot make every delivery read the whole realm.
 */
import { describe, expect, it } from 'vitest';
import { MEMBERS_REFRESH_MS, RealmMembers } from '../src/members.js';
import type { RealmMember } from '../src/wire.js';

const BOT: RealmMember = { user_id: 7, email: 'bot@localhost', full_name: 'claude-code-bot' };
const named = (name: string, id?: number) => [{ name, id }];

function realm(start: RealmMember[] = []) {
  const state = { members: start, reads: 0, now: 1_000_000, fail: false };
  const members = new RealmMembers(async () => {
    state.reads++;
    if (state.fail) throw new Error('unreachable');
    return state.members;
  }, () => state.now);
  return { state, members };
}

describe('RealmMembers', () => {
  it('never reads the realm for a message whose names it already knows', async () => {
    const { state, members } = realm([BOT]);
    await members.learn(named('claude-code-bot'));
    state.now += MEMBERS_REFRESH_MS;
    await members.learn(named('claude-code-bot', 7));
    await members.learn([]);
    expect(state.reads).toBe(1);
  });

  it('reads the realm at most once per interval for a name nobody has', async () => {
    const { state, members } = realm([BOT]);
    for (let i = 0; i < 5; i++) await members.learn(named('nobody'));
    state.now += MEMBERS_REFRESH_MS - 1;
    await members.learn(named('nobody'));
    expect(state.reads).toBe(1);
    state.now += 1;
    await members.learn(named('nobody'));
    expect(state.reads).toBe(2);
  });

  it('shares one read between deliveries that ask at once, and each waits for it', async () => {
    const { state, members } = realm([BOT]);
    const first = members.learn(named('claude-code-bot'));
    await members.learn(named('claude-code-bot'));
    expect(members.lookup('claude-code-bot', undefined)).toBe('claude-code-bot');
    await first;
    expect(state.reads).toBe(1);
  });

  it('reads a name as nobody when the realm cannot be read, and keeps what an earlier read learnt', async () => {
    const { state, members } = realm();
    state.fail = true;
    await members.learn(named('claude-code-bot'));
    expect(members.lookup('claude-code-bot', undefined)).toBeUndefined();

    state.fail = false;
    state.members = [BOT];
    state.now += MEMBERS_REFRESH_MS;
    await members.learn(named('claude-code-bot'));
    state.fail = true;
    state.now += MEMBERS_REFRESH_MS;
    await members.learn(named('someone-new'));
    expect(members.lookup('claude-code-bot', undefined)).toBe('claude-code-bot');
  });

  it('skips a member record it cannot read, and keeps the rest', async () => {
    const { members } = realm([null as never, { user_id: 'x' } as never, { user_id: 9 } as never, BOT]);
    await members.learn(named('claude-code-bot'));
    expect(members.lookup('claude-code-bot', 7)).toBe('claude-code-bot');
  });
});
