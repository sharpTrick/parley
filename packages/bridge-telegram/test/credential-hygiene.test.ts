import { asTopic } from '@sharptrick/parley-core';
import { MAX_ERROR_BODY } from '@sharptrick/parley-net-util';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, KNOWN_CHANNEL } from './fake-telegram.js';
import {
  captureStderr,
  connectTo,
  registerCleanup,
  SENDER,
  startFake,
  storePath,
} from './rig.js';

/** A word only the upstream's own body can supply — the positive control for "the body was quoted". */
const ECHO = 'UPSTREAM-ECHO';
const POST_CHAT = '-1009630001';

/**
 * Unlike every sibling backend, this API carries its credential in the URL **path**
 * (`/bot<token>/<method>`), so an upstream that echoes the request line hands the bot token to
 * whatever quotes it: an `isError` MCP result (model context) or the operator's stderr. net-util
 * redacts the status and transport paths, but a 2xx envelope reaches neither — a `{"ok":false}`
 * refusal is a SUCCESSFUL HTTP response — and the plugin's own quoting only bounded and flattened
 * the body.
 *
 * Rows are every way an upstream can fail; columns are every seam call that quotes one, plus the
 * ingestion loop, which has no caller to reject and so quotes to stderr instead. Each cell makes the
 * upstream echo the full credential-bearing request URL and asserts the diagnostic carries NEITHER
 * spelling of the token — raw or percent-encoded, which differ because a real token contains a colon.
 */
interface Upstream {
  name: string;
  /** Break `method` so its next answer echoes `url`. */
  arm: (fake: FakeTelegram, method: string, url: string) => void;
  /** Whether the upstream's own words are expected to reach the diagnostic at all. */
  quoted: boolean;
}

const UPSTREAMS: Upstream[] = [
  {
    name: 'a 2xx ok:false whose description echoes the request URL',
    arm: (fake, method, url) =>
      fake.malformMethod(method, JSON.stringify({ ok: false, description: `${ECHO} ${url}` })),
    quoted: true,
  },
  {
    name: 'a 2xx ok:true with no result, echoing the request URL',
    arm: (fake, method, url) =>
      fake.malformMethod(method, JSON.stringify({ ok: true, note: `${ECHO} ${url}` })),
    quoted: true,
  },
  {
    name: 'a non-JSON 2xx body echoing the request URL',
    arm: (fake, method, url) => fake.malformMethod(method, `${ECHO} ${url}`),
    quoted: true,
  },
  {
    name: 'a 4xx status body echoing the request URL',
    arm: (fake, method, url) => fake.failMethod(method, { status: 400, description: `${ECHO} ${url}` }),
    quoted: true,
  },
  {
    name: 'a transport failure mid-body',
    arm: (fake, method) => fake.stallMethod(method, 'close-mid-body'),
    quoted: false,
  },
];

/**
 * A seam call, the endpoint it fails on, and where its diagnostic comes out. `resolveIdentity` is
 * deliberately absent: it reads the `getMe` memo `connect` already filled, so a broken `getMe` is
 * the connect row and nothing else.
 */
const CALLERS = [
  { name: 'connect, on the getMe preflight', method: 'getMe' },
  { name: 'fetchRecent, resolving an @name topic', method: 'getChat' },
  { name: 'subscribe, resolving an @name topic', method: 'getChat' },
  { name: 'post, on sendMessage', method: 'sendMessage' },
  { name: 'the ingestion loop, which reports to stderr', method: 'getUpdates' },
] as const;

const CELLS = CALLERS.flatMap((caller) => UPSTREAMS.map((upstream) => ({ caller, upstream })));

/** The message a rejecting seam call produced, or '' when it did not reject. */
const said = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => '',
    (e: unknown) => (e as Error).message,
  );

describe('telegram diagnostics never carry the bot token', () => {
  it.each(CELLS)('$caller.name, given $upstream.name', async ({ caller, upstream }) => {
    const stderr = captureStderr();
    const fake = await startFake();
    const requestUrl = `${fake.url}/bot${fake.token}/${caller.method}`;
    let diagnostic = '';
    if (caller.name === 'connect, on the getMe preflight') {
      upstream.arm(fake, caller.method, requestUrl);
      const plugin = new TelegramPlugin();
      registerCleanup(() => plugin.disconnect());
      diagnostic = await said(
        plugin.connect({
          token: fake.token,
          api_url: fake.url,
          store_path: storePath(),
          poll_timeout_s: 1,
        }),
      );
    } else if (caller.name === 'the ingestion loop, which reports to stderr') {
      upstream.arm(fake, caller.method, requestUrl);
      await connectTo(fake, storePath());
      await vi.waitFor(() => expect(stderr.join('')).toContain('getUpdates'), {
        timeout: 8000,
        interval: 20,
      });
      diagnostic = stderr.join('');
    } else {
      const plugin = await connectTo(fake, storePath());
      upstream.arm(fake, caller.method, requestUrl);
      const channel = asTopic(KNOWN_CHANNEL.username);
      if (caller.name === 'fetchRecent, resolving an @name topic') {
        diagnostic = await said(plugin.fetchRecent({ topic: channel }));
      } else if (caller.name === 'subscribe, resolving an @name topic') {
        diagnostic = await said(plugin.subscribe(channel, () => undefined));
      } else {
        diagnostic = await said(plugin.post(asTopic(POST_CHAT), SENDER, 'x'));
      }
    }

    // The cell really produced a diagnostic, and — where the upstream's words are quoted at all —
    // really quoted the body that carried the credential. Without this the assertions below pass on
    // an empty string.
    expect(diagnostic).not.toBe('');
    if (upstream.quoted) expect(diagnostic).toContain(ECHO);

    for (const spelling of [fake.token, encodeURIComponent(fake.token)]) {
      expect(diagnostic).not.toContain(spelling);
    }
    // Everything captured on stderr, not only the line this call produced: a throttled diagnostic
    // from the poll loop is written by the same process and read by the same operator.
    for (const line of stderr) {
      for (const spelling of [fake.token, encodeURIComponent(fake.token)]) {
        expect(line).not.toContain(spelling);
      }
    }
  }, 20_000);

  /**
   * The fake authenticates on the token, so a passing row above proves the credential really was on
   * the wire — but only while the token is spelled the way a real one is. A token of plain word
   * characters percent-encodes to itself, which silently collapses the two spellings into one.
   */
  it('is graded against a token whose percent-encoded spelling differs', async () => {
    const fake = await startFake();
    expect(encodeURIComponent(fake.token)).not.toBe(fake.token);
  });
});

/**
 * Every row above breaks the ENVELOPE, so every one is thrown INSIDE `BotApi.call` and redacted by
 * the single `catch` there — which leaves the discriminating case ungraded. A WELL-FORMED `ok:true`
 * answer returns from that call normally, and the plugin then composes its own diagnostics out of
 * the RESULT FIELDS: the chat id an upstream stamped, which it quotes when that id is not one
 * Telegram could serve. Those messages are built after the HTTP call has returned, so what has to
 * redact them is the SEAM, not the call. This is the row that tells "the HTTP call redacts" apart
 * from "the plugin redacts".
 *
 * The upstream poisons EVERY string-valued field of the result rather than the one field today's
 * rejection happens to quote, so a diagnostic that later quotes a different one is graded by the
 * same cells. The echo carries forged line structure and is longer than `MAX_ERROR_BODY` too,
 * because a quoted upstream value is untrusted twice over: it must not carry the credential, and it
 * must not reach model context unbounded or unflattened.
 */
describe('telegram diagnostics on a well-formed answer', () => {
  /** ECHO first, so that the credential survives the truncation the padding after it forces. */
  const echoOf = (url: string): string => `${ECHO}\n${url}\u0007${'A'.repeat(MAX_ERROR_BODY * 2)}`;

  /** A well-formed `ok:true` answer for `method` whose every string-valued result field is `echo`. */
  const answer = (method: string, echo: string): string => {
    const chat = { id: echo, type: echo, username: echo };
    const message = {
      message_id: 1,
      date: 1_700_000_000,
      chat,
      from: { id: 5, is_bot: false, username: echo, first_name: echo },
      text: echo,
    };
    const result =
      method === 'getChat' ? chat : method === 'getUpdates' ? [{ update_id: 1, message }] : message;
    return JSON.stringify({ ok: true, result });
  };

  /** The seam calls that quote a field off a SUCCESSFUL answer, and the endpoint each reads. */
  const QUOTING = [
    { name: 'post', method: 'sendMessage' },
    { name: 'fetchRecent', method: 'getChat' },
    { name: 'subscribe', method: 'getChat' },
    { name: 'the ingestion loop', method: 'getUpdates' },
  ] as const;

  it.each(QUOTING)('$name quotes the $method result without the token', async ({ name, method }) => {
    const stderr = captureStderr();
    const fake = await startFake();
    const plugin = await connectTo(fake, storePath());
    fake.malformMethod(method, answer(method, echoOf(`${fake.url}/bot${fake.token}/${method}`)));

    let diagnostic = '';
    if (name === 'the ingestion loop') {
      await vi.waitFor(() => expect(stderr.join('')).toContain(ECHO), { timeout: 8000, interval: 20 });
      diagnostic = (stderr.find((l) => l.includes(ECHO)) ?? '').trimEnd();
    } else if (name === 'post') {
      diagnostic = await said(plugin.post(asTopic(POST_CHAT), SENDER, 'x'));
    } else if (name === 'fetchRecent') {
      diagnostic = await said(plugin.fetchRecent({ topic: asTopic(KNOWN_CHANNEL.username) }));
    } else {
      diagnostic = await said(plugin.subscribe(asTopic(KNOWN_CHANNEL.username), () => undefined));
    }

    // The cell really produced a diagnostic and really quoted the field that carried the credential.
    expect(diagnostic).not.toBe('');
    expect(diagnostic).toContain(ECHO);
    for (const spelling of [fake.token, encodeURIComponent(fake.token)]) {
      expect(diagnostic).not.toContain(spelling);
      for (const line of stderr) expect(line).not.toContain(spelling);
    }
    // Bounded and flattened, like every other untrusted body this plugin quotes.
    expect(diagnostic).not.toContain('\n');
    expect(diagnostic.length).toBeLessThan(MAX_ERROR_BODY + 512);
  }, 20_000);
});
