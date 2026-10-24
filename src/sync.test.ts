import assert from 'node:assert/strict';
import test from 'node:test';
import { syncItems } from './sync';
import type { Destination, ResolvedItem, SourceEntry, SourceTree } from './types';

interface FileNode {
  kind: 'file';
  mode: number;
  bytes: Uint8Array;
}
interface DirNode {
  kind: 'dir';
  children: Record<string, Node>;
}
interface LinkNode {
  kind: 'symlink';
  target: string;
}
type Node = FileNode | DirNode | LinkNode;

function file(text: string, mode = 0o644): FileNode {
  return { kind: 'file', mode, bytes: new TextEncoder().encode(text) };
}

function sourceFrom(root: DirNode): SourceTree & { reads: string[]; lists: string[] } {
  const reads: string[] = [];
  const lists: string[] = [];
  function get(absolute: string): Node | null {
    const parts = absolute.split('/').filter(Boolean);
    let current: Node = root;
    for (const part of parts) {
      if (current.kind !== 'dir' || !current.children[part]) return null;
      current = current.children[part];
    }
    return current;
  }
  return {
    reads,
    lists,
    async list(absolutePath: string): Promise<SourceEntry[]> {
      lists.push(absolutePath);
      const node = get(absolutePath);
      if (!node || node.kind !== 'dir') {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return Object.entries(node.children).map(([name, child]) => ({
        name,
        kind: child.kind,
        mode: child.kind === 'file' ? child.mode : 0o777,
      }));
    },
    async readFile(absolutePath: string): Promise<Uint8Array> {
      reads.push(absolutePath);
      const node = get(absolutePath);
      if (!node || node.kind !== 'file') throw new Error(`not a file: ${absolutePath}`);
      return node.bytes;
    },
    async readlink(absolutePath: string): Promise<string> {
      const node = get(absolutePath);
      if (!node || node.kind !== 'symlink') throw new Error('not a link');
      return node.target;
    },
    async statFollow(absolutePath: string): Promise<SourceEntry | null> {
      const node = get(absolutePath);
      if (!node) return null;
      if (node.kind === 'symlink') return null;
      return { name: absolutePath, kind: node.kind, mode: node.kind === 'file' ? node.mode : 0o755 };
    },
  };
}

class MemDest implements Destination {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  writes: string[] = [];
  async readFile(absolutePath: string): Promise<Uint8Array | null> {
    return this.files.get(absolutePath) ?? null;
  }
  async writeFile(absolutePath: string, bytes: Uint8Array): Promise<void> {
    this.writes.push(absolutePath);
    this.files.set(absolutePath, bytes);
  }
  async mkdir(absolutePath: string): Promise<void> {
    this.dirs.add(absolutePath);
  }
}

function text(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes ?? new Uint8Array());
}

const skill: ResolvedItem = {
  id: '/host/skills/time',
  kind: 'skill',
  name: 'time',
  source: '/host/skills/time',
  target: '~/.cursor/skills/time',
  enabled: true,
  scope: 'workspace',
  origin: 'discovered',
};

test('copies nested files, preserves executable requests, skips git and outside symlinks, and keeps extra dest files', async () => {
  const source = sourceFrom({
    kind: 'dir',
    children: {
      host: {
        kind: 'dir',
        children: {
          skills: {
            kind: 'dir',
            children: {
              time: {
                kind: 'dir',
                children: {
                  'SKILL.md': file('---\nname: time\n---\n'),
                  scripts: {
                    kind: 'dir',
                    children: {
                      'now.sh': file('#!/bin/sh\ndate\n', 0o755),
                    },
                  },
                  '.git': { kind: 'dir', children: { config: file('secret') } },
                  'escape.sh': { kind: 'symlink', target: '/etc/hostname' },
                  'inside.sh': { kind: 'symlink', target: 'scripts/now.sh' },
                  'loop': { kind: 'symlink', target: '../time' },
                },
              },
            },
          },
        },
      },
    },
  });
  const dest = new MemDest();
  dest.files.set('/home/vscode/.cursor/skills/time/extra.txt', file('keep').bytes);

  const report = await syncItems([skill], source, dest, '/home/vscode');
  assert.equal(report.errors.length, 0);
  assert.equal(text(dest.files.get('/home/vscode/.cursor/skills/time/SKILL.md')).includes('name: time'), true);
  assert.equal(text(dest.files.get('/home/vscode/.cursor/skills/time/scripts/now.sh')).includes('date'), true);
  assert.equal(text(dest.files.get('/home/vscode/.cursor/skills/time/extra.txt')), 'keep');
  assert.equal([...dest.files.keys()].some((path) => path.includes('.git')), false);
  assert.equal([...dest.files.values()].some((bytes) => text(bytes).includes('secret')), false);
  assert.equal(dest.files.has('/home/vscode/.cursor/skills/time/escape.sh'), false);
  assert.equal(text(dest.files.get('/home/vscode/.cursor/skills/time/inside.sh')).includes('date'), true);
  assert.deepEqual(report.executables.sort(), [
    '/home/vscode/.cursor/skills/time/inside.sh',
    '/home/vscode/.cursor/skills/time/scripts/now.sh',
  ]);
  assert.equal(report.skipped.some((item) => item.reason === 'git'), true);
  assert.equal(report.skipped.some((item) => item.reason === 'symlink-escapes'), true);
  assert.equal(report.skipped.some((item) => item.reason === 'directory-symlink'), true);
  assert.equal(source.reads.includes('/etc/hostname'), false);
});

test('second sync does not rewrite identical files but still requests chmod for executables', async () => {
  const source = sourceFrom({
    kind: 'dir',
    children: {
      host: {
        kind: 'dir',
        children: {
          skills: {
            kind: 'dir',
            children: {
              time: {
                kind: 'dir',
                children: {
                  'SKILL.md': file('same'),
                  'now.sh': file('#!/bin/sh\n', 0o755),
                },
              },
            },
          },
        },
      },
    },
  });
  const dest = new MemDest();
  await syncItems([skill], source, dest, '/home/vscode');
  dest.writes.length = 0;
  const again = await syncItems([skill], source, dest, '/home/vscode');
  assert.deepEqual(dest.writes, []);
  assert.equal(again.copied, 0);
  assert.equal(again.unchanged, 2);
  assert.deepEqual(again.executables, ['/home/vscode/.cursor/skills/time/now.sh']);
});

test('changed bytes are copied and disabled items are not read', async () => {
  const source = sourceFrom({
    kind: 'dir',
    children: {
      host: {
        kind: 'dir',
        children: {
          skills: { kind: 'dir', children: { time: { kind: 'dir', children: { 'SKILL.md': file('new') } } } },
        },
      },
    },
  });
  const dest = new MemDest();
  dest.files.set('/home/vscode/.cursor/skills/time/SKILL.md', file('old').bytes);
  const report = await syncItems([skill], source, dest, '/home/vscode');
  assert.equal(text(dest.files.get('/home/vscode/.cursor/skills/time/SKILL.md')), 'new');
  assert.equal(report.copied, 1);

  const disabled: ResolvedItem = { ...skill, enabled: false };
  source.reads.length = 0;
  source.lists.length = 0;
  await syncItems([disabled], source, dest, '/home/vscode');
  assert.deepEqual(source.reads, []);
  assert.deepEqual(source.lists, []);
});

test('a target outside the container home is not written', async () => {
  const source = sourceFrom({
    kind: 'dir',
    children: { data: { kind: 'dir', children: { 'a.txt': file('x') } } },
  });
  const dest = new MemDest();
  const item: ResolvedItem = {
    ...skill,
    source: '/data',
    target: '/etc/passwd',
  };
  const report = await syncItems([item], source, dest, '/home/vscode');
  assert.equal(dest.writes.length, 0);
  assert.equal(report.errors.length, 1);
});

test('a folder without a target and a missing source are skipped with a warning', async () => {
  const source = sourceFrom({ kind: 'dir', children: {} });
  const dest = new MemDest();
  const other: ResolvedItem = {
    ...skill,
    id: '/Users/example/projects/my-tools',
    kind: 'folder',
    name: 'my-tools',
    source: '/Users/example/projects/my-tools',
    target: '',
    origin: 'manual',
  };
  const missing: ResolvedItem = {
    ...skill,
    id: '/host/missing',
    source: '/host/missing',
    target: '~/.cursor/skills/missing',
  };
  const report = await syncItems([other, missing], source, dest, '/home/vscode');
  assert.equal(dest.writes.length, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0]?.message ?? '', /target/i);
  assert.match(report.warnings[1]?.message ?? '', /does not exist/i);
});
