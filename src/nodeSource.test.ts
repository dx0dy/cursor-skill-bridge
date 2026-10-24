import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverCursorItems } from './discover';
import { createNodeSourceTree } from './nodeSource';
import { syncItems } from './sync';
import type { Destination } from './types';

class MemDest implements Destination {
  files = new Map<string, Uint8Array>();
  async readFile(absolutePath: string): Promise<Uint8Array | null> {
    return this.files.get(absolutePath) ?? null;
  }
  async writeFile(absolutePath: string, bytes: Uint8Array): Promise<void> {
    this.files.set(absolutePath, bytes);
  }
  async mkdir(): Promise<void> {}
}

test('node source reads the host tree and does not change it', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-bridge-host-'));
  const skillDir = path.join(home, '.cursor', 'skills', 'time');
  const script = path.join(skillDir, 'scripts', 'now.sh');
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.join(skillDir, '.git'), { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: time\n---\n');
  writeFileSync(script, '#!/bin/sh\necho now\n', { mode: 0o755 });
  writeFileSync(path.join(skillDir, '.git', 'config'), 'do-not-copy');
  symlinkSync('/etc/hostname', path.join(skillDir, 'escape.sh'));
  const pluginDir = path.join(home, '.cursor', 'plugins', 'local', 'demo');
  mkdirSync(path.join(pluginDir, '.cursor-plugin'), { recursive: true });
  writeFileSync(path.join(pluginDir, '.cursor-plugin', 'plugin.json'), '{"name":"demo"}\n');
  mkdirSync(path.join(home, '.cursor', 'plugins', 'cache', 'hidden'), { recursive: true });
  writeFileSync(path.join(home, '.cursor', 'plugins', 'cache', 'hidden', 'plugin.json'), '{}');
  mkdirSync(path.join(home, '.cursor', 'plugins', 'local', 'loose'), { recursive: true });

  const before = {
    script: readFileSync(script),
    mode: statSync(script).mode,
    mtime: statSync(script).mtimeMs,
    skill: readFileSync(path.join(skillDir, 'SKILL.md')),
  };

  const source = createNodeSourceTree();
  const found = await discoverCursorItems(home, source);
  assert.deepEqual(
    found.map((item) => path.basename(item.source)).sort(),
    ['demo', 'time'],
  );

  const dest = new MemDest();
  const report = await syncItems(
    found.map((item) => ({ ...item, enabled: true, scope: 'workspace' as const, origin: 'discovered' as const })),
    source,
    dest,
    '/home/vscode',
  );

  const copiedScript = dest.files.get('/home/vscode/.cursor/skills/time/scripts/now.sh');
  const manifest = dest.files.get('/home/vscode/.cursor/plugins/local/demo/.cursor-plugin/plugin.json');
  assert.equal(Buffer.from(copiedScript ?? []).toString().includes('echo now'), true);
  assert.equal(Buffer.from(manifest ?? []).toString().includes('"demo"'), true);
  assert.equal([...dest.files.keys()].some((item) => item.includes('.git')), false);
  assert.equal([...dest.files.keys()].includes('/home/vscode/.cursor/skills/time/escape.sh'), false);
  assert.equal(report.executables.includes('/home/vscode/.cursor/skills/time/scripts/now.sh'), true);
  assert.equal(readFileSync(script).equals(before.script), true);
  assert.equal(statSync(script).mode, before.mode);
  assert.equal(statSync(script).mtimeMs, before.mtime);
  assert.equal(readFileSync(path.join(skillDir, 'SKILL.md')).equals(before.skill), true);
  chmodSync(script, before.mode);
});
