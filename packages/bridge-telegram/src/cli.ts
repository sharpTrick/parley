#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { TelegramPlugin } from './index.js';

void runBackendCli({ bin: 'parley-telegram', moduleUrl: import.meta.url, plugin: () => new TelegramPlugin() });
