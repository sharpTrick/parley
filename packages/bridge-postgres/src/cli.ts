#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { PostgresPlugin } from './index.js';

void runBackendCli({ bin: 'parley-postgres', moduleUrl: import.meta.url, plugin: () => new PostgresPlugin() });
