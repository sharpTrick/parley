#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { SqlitePlugin } from './index.js';

void runBackendCli({ bin: 'parley-sqlite', moduleUrl: import.meta.url, plugin: () => new SqlitePlugin() });
