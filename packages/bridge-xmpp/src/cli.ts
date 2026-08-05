#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { XmppPlugin } from './index.js';

void runBackendCli({ bin: 'parley-xmpp', moduleUrl: import.meta.url, plugin: () => new XmppPlugin() });
