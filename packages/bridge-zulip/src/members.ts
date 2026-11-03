import { asArray, type RealmMember } from './wire.js';

/** How long an unknown name waits before it may make the realm's members be read again. */
export const MEMBERS_REFRESH_MS = 30_000;

/** Who `@**name**` or `@**name|id**` names, as Zulip would resolve it; `undefined` when nobody. */
export type MemberLookup = (name: string, id: number | undefined) => string | undefined;

/**
 * The realm's active members, as Zulip's markdown resolves a mention against them: `@**name|id**`
 * names the member with that id only if `name` is exactly their full name, and `@**name**` names the
 * member whose full name matches without regard to case. Zulip renders any other spelling as text,
 * so it addresses nobody.
 */
export class RealmMembers {
  private byId = new Map<number, string>();
  private byName = new Map<string, string>();
  private readAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | undefined;

  constructor(
    private readonly read: () => Promise<RealmMember[]>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  readonly lookup: MemberLookup = (name, id) => {
    if (id !== undefined) return this.byId.get(id) === name ? name : undefined;
    return this.byName.get(name.toLowerCase());
  };

  /**
   * Read the members again when one of `mentions` names nobody this directory knows. Keep the
   * refresh paced, so that a message naming someone who does not exist cannot make every delivery
   * read the whole realm. A failed read leaves the directory as it was, so that such a name reads as
   * the text Zulip would show rather than as an address.
   */
  async learn(mentions: readonly { name: string; id: number | undefined }[]): Promise<void> {
    const known = (): boolean => mentions.every(({ name, id }) => this.lookup(name, id) !== undefined);
    if (this.reading !== undefined) await this.reading;
    if (known() || this.now() - this.readAt < MEMBERS_REFRESH_MS) return;
    this.reading = this.refresh().finally(() => {
      this.reading = undefined;
    });
    await this.reading;
  }

  private async refresh(): Promise<void> {
    this.readAt = this.now();
    let members: RealmMember[];
    try {
      members = asArray(await this.read());
    } catch {
      return;
    }
    const active = members.filter(
      (u) => u?.is_active !== false && typeof u?.full_name === 'string' && Number.isSafeInteger(u?.user_id),
    );
    this.byId = new Map(active.map((u) => [u.user_id, u.full_name]));
    this.byName = new Map(active.map((u) => [u.full_name.toLowerCase(), u.full_name]));
  }
}
