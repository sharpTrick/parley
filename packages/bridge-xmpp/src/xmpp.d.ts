// @xmpp/* packages ship no type declarations and there is no @types package. The plugin uses
// their runtime API (client/xml) untyped; declare the modules so the build is clean.
declare module '@xmpp/client';
declare module '@xmpp/debug';
declare module '@xmpp/xml';
declare module '@xmpp/jid';
