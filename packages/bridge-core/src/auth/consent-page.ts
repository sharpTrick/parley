import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { escapeHtml } from './html.js';

export function renderConsentPage(
  consentId: string,
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  consentPath: string,
): string {
  const name = escapeHtml(client.client_name ?? client.client_id);
  const scopeList = (params.scopes ?? []).map(escapeHtml).join(', ') || '(none requested)';
  const redirect = escapeHtml(identifyingRedirect(params.redirectUri));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parley — authorize</title>
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:1.5rem}label{display:block;margin:1rem 0 .25rem}
input[type=password]{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;font-size:1rem}
button{margin-top:1.25rem;padding:.6rem 1.25rem;border:0;border-radius:8px;background:#111;color:#fff;font-size:1rem;cursor:pointer}
.muted{color:#666;font-size:.9rem}</style></head>
<body><div class="box"><h1>Authorize access to Parley</h1>
<p>A client at <strong>${redirect}</strong> wants to connect to your Parley bridge.</p>
<p class="muted">Client-supplied name: ${name}<br>Scopes: ${scopeList}</p>
<p>Enter your owner passphrase to approve. This is the only party that can authorize this bridge.</p>
<form method="POST" action="${escapeHtml(consentPath)}">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<label for="passphrase">Owner passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="off" autofocus required>
<button type="submit">Approve</button></form></div></body></html>`;
}

export function renderConsentRefusal(message: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:32rem;margin:3rem auto">` +
    `<h1>Not authorized</h1><p>${escapeHtml(message)}.</p><p><a href="javascript:history.back()">Go back</a></p></body>`;
}

/**
 * The consent page leads with the redirect target because it is the one thing on the page the
 * client cannot choose freely. `URL.origin` is the opaque string `'null'` for every non-special
 * scheme (`myapp://cb`), so taking it unconditionally would print a literal `null` as the client's
 * identity and leave the attacker-supplied `client_name` as the only thing the owner can read. Fall
 * back to the whole URI, which at least names the scheme and host the code would be handed to.
 */
function identifyingRedirect(redirectUri: string): string {
  try {
    const { origin } = new URL(redirectUri);
    return origin === 'null' ? redirectUri : origin;
  } catch {
    return redirectUri;
  }
}
