#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { RedisPlugin } from './index.js';

void runBackendCli({ bin: 'parley-redis', moduleUrl: import.meta.url, plugin: () => new RedisPlugin() });
