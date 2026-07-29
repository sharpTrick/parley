#!/usr/bin/env node
// Provision one throwaway git worktree per Careening review target, all pinned to the SAME commit.
//
//   node scripts/careening-worktrees.mjs setup <sha>
//   node scripts/careening-worktrees.mjs teardown
//
// Why: critics must review one immutable snapshot, and they must be free to mutate source to prove
// a test is vacuous. Both are impossible in a shared tree — during round 2 the orchestrator
// committed twice while critics were mid-read, and three round-1 agents mutated the working tree
// other agents were building against.
//
// node_modules is hard-linked (`cp -al`), so a worktree costs ~3 MB rather than 173 MB, and the
// workspace symlinks resolve INSIDE it (node_modules/@sharptrick/parley-core -> ../../packages/…),
// which is what makes the isolation real rather than cosmetic.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/user/parley';
const BASE = '/tmp/careening/worktrees';

export const TARGETS = [
  'core-seam',
  'core-engine',
  'core-auth',
  'sqlite',
  'redis',
  'postgres',
  'matrix',
  'xmpp',
  'nats',
  'zulip',
  'discord',
  'slack',
  'telegram',
  'shared',
];

const sh = (cmd, args, cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function setup(sha) {
  if (!sha) throw new Error('usage: careening-worktrees.mjs setup <sha>');
  const resolved = sh('git', ['rev-parse', sha]).trim();
  mkdirSync(BASE, { recursive: true });
  for (const t of TARGETS) {
    const path = join(BASE, t);
    if (existsSync(path)) {
      try {
        sh('git', ['worktree', 'remove', '--force', path]);
      } catch {
        rmSync(path, { recursive: true, force: true });
      }
    }
    sh('git', ['worktree', 'add', '--detach', path, resolved]);
    // Hard-link rather than copy: same inodes, so this is ~free on disk and instant.
    sh('cp', ['-al', join(ROOT, 'node_modules'), join(path, 'node_modules')]);
    process.stdout.write(`${t} -> ${path}\n`);
  }
  process.stdout.write(`\n${TARGETS.length} worktrees at ${resolved.slice(0, 7)}\n`);
}

function teardown() {
  for (const t of TARGETS) {
    const path = join(BASE, t);
    if (!existsSync(path)) continue;
    // Remove the hard-linked tree first; `git worktree remove` would walk all 561 packages.
    rmSync(join(path, 'node_modules'), { recursive: true, force: true });
    try {
      sh('git', ['worktree', 'remove', '--force', path]);
    } catch {
      rmSync(path, { recursive: true, force: true });
    }
  }
  sh('git', ['worktree', 'prune']);
  process.stdout.write('worktrees removed\n');
}

const [, , cmd, arg] = process.argv;
if (cmd === 'setup') setup(arg);
else if (cmd === 'teardown') teardown();
else throw new Error('usage: careening-worktrees.mjs <setup <sha>|teardown>');
