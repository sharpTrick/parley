#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { SlackPlugin } from './index.js';

void runBackendCli({ bin: 'parley-slack', moduleUrl: import.meta.url, plugin: () => new SlackPlugin() });
