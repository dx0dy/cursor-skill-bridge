import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveContainerHome } from './home';

test('HOME probe result is accepted only when the remote filesystem can read it back', async () => {
  const reads: string[] = [];
  const home = await resolveContainerHome({
    async run() {
      return 0;
    },
    async readFile(absolutePath: string) {
      reads.push(absolutePath);
      return new TextEncoder().encode('/home/vscode');
    },
    async remove() {},
    async exists(absolutePath: string) {
      return absolutePath === '/home/vscode';
    },
  });
  assert.equal(home, '/home/vscode');
  assert.equal(reads[0]?.startsWith('/tmp/cursor-skill-bridge-'), true);
});

test('falls back to /home/vscode when the probe did not land in the container', async () => {
  const home = await resolveContainerHome({
    async run() {
      return 0;
    },
    async readFile() {
      return null;
    },
    async remove() {},
    async exists(absolutePath: string) {
      return absolutePath === '/home/vscode';
    },
  });
  assert.equal(home, '/home/vscode');
});

test('falls back to /root and then fails', async () => {
  const root = await resolveContainerHome({
    async run() {
      return 1;
    },
    async readFile() {
      return null;
    },
    async remove() {},
    async exists(absolutePath: string) {
      return absolutePath === '/root';
    },
  });
  assert.equal(root, '/root');

  await assert.rejects(() =>
    resolveContainerHome({
      async run() {
        return 1;
      },
      async readFile() {
        return null;
      },
      async remove() {},
      async exists() {
        return false;
      },
    }),
  );
});
