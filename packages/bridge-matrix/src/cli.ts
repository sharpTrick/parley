#!/usr/bin/env node
import { runBackendCli } from '@sharptrick/parley-core';
import { MatrixPlugin } from './index.js';

void runBackendCli({ bin: 'parley-matrix', moduleUrl: import.meta.url, plugin: () => new MatrixPlugin() });
