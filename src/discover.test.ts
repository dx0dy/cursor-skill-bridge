import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverCursorItems } from './discover';
import type { SourceEntry, SourceTree } from './types';

interface Node {
  kind: 'dir' | 'file' | 'symlink';
  mode?: number;
  text?: string;
  target?: string;
  children?: Record<string, Node>;
}

function treeSource(root: Node): SourceTree & { calls: string[] } {
  const calls: string[] = [];
  function walk(node: Node, parts: string[]): Node | null {
    let current = root;
    for (const part of parts) {
      if (current.kind !== 'dir' || !current.children?.[part]) return null;
      current = current.children[part];
    }
    return current;
  }
  function resolve(absolute: string): string[] {
    return absolute.split('/').filter(Boolean);
  }
  return {
    calls,
    async list(absolutePath: string): Promise<SourceEntry[]> {
      calls.push(`list:${absolutePath}`);
      const node = walk(root, resolve(absolutePath));
      if (!node || node.kind !== 'dir') {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return Object.entries(node.children ?? {}).map(([name, child]) => ({
        name,
        kind: child.kind,
        mode: child.mode ?? (child.kind === 'file' ? 0o644 : 0o755),
      }));
    },
    async readFile(absolutePath: string): Promise<Uint8Array> {
      calls.push(`read:${absolutePath}`);
      const node = walk(root, resolve(absolutePath));
      if (!node || node.kind !== 'file') {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return new TextEncoder().encode(node.text ?? '');
    },
    async readlink(): Promise<string> {
      throw new Error('not used');
    },
    async statFollow(): Promise<SourceEntry | null> {
      return null;
    },
  };
}

test('discovers user skills and local plugins, and does not scan the marketplace cache', async () => {
  const source = treeSource({
    kind: 'dir',
    children: {
      home: {
        kind: 'dir',
        children: {
          '.cursor': {
            kind: 'dir',
            children: {
              skills: {
                kind: 'dir',
                children: {
                  'sequential-best-of-n': { kind: 'dir', children: {} },
                  'notes.txt': { kind: 'file', text: 'no' },
                },
              },
              plugins: {
                kind: 'dir',
                children: {
                  cache: {
                    kind: 'dir',
                    children: {
                      hidden: {
                        kind: 'dir',
                        children: {
                          '.cursor-plugin': {
                            kind: 'dir',
                            children: { 'plugin.json': { kind: 'file', text: '{}' } },
                          },
                        },
                      },
                    },
                  },
                  local: {
                    kind: 'dir',
                    children: {
                      demo: {
                        kind: 'dir',
                        children: {
                          '.cursor-plugin': {
                            kind: 'dir',
                            children: { 'plugin.json': { kind: 'file', text: '{"name":"demo"}' } },
                          },
                        },
                      },
                      loose: { kind: 'dir', children: { 'readme.txt': { kind: 'file', text: 'no manifest' } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const items = await discoverCursorItems('/home', source);
  assert.deepEqual(
    items.map((item) => item.source),
    ['/home/.cursor/skills/sequential-best-of-n', '/home/.cursor/plugins/local/demo'],
  );
  assert.equal(items[0]?.target, '~/.cursor/skills/sequential-best-of-n');
  assert.equal(items[1]?.target, '~/.cursor/plugins/local/demo');
  assert.equal(source.calls.some((call) => call.includes('/plugins/cache')), false);
});
