#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { NatsPlugin } from './index.js';

void runBackendCli({ bin: 'parley-nats', moduleUrl: import.meta.url, plugin: () => new NatsPlugin() });
