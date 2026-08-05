#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { ZulipPlugin } from './index.js';

void runBackendCli({ bin: 'parley-zulip', moduleUrl: import.meta.url, plugin: () => new ZulipPlugin() });
