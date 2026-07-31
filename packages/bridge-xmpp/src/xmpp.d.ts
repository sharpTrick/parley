/**
 * `@xmpp/*` ships no type declarations and there is no `@types` package, so the plugin uses their
 * runtime API (`client`/`xml`) untyped and declares the modules here to keep the build clean.
 */
declare module '@xmpp/client';
declare module '@xmpp/xml';
declare module '@xmpp/jid';
