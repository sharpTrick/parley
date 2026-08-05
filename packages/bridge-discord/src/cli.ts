#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { DiscordPlugin } from './index.js';

void runBackendCli({ bin: 'parley-discord', moduleUrl: import.meta.url, plugin: () => new DiscordPlugin() });
