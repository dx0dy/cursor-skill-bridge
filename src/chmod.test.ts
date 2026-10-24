import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildChmodPayload } from './chmod';

test('chmod payload only targets the container home and makes a script executable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-bridge-chmod-'));
  const inside = path.join(root, 'now.sh');
  const outside = path.join(tmpdir(), `skill-bridge-outside-${Date.now()}.sh`);
  writeFileSync(inside, '#!/bin/sh\necho ok\n', { mode: 0o644 });
  writeFileSync(outside, '#!/bin/sh\necho no\n', { mode: 0o644 });

  const payload = buildChmodPayload([inside, outside, `${inside}\ninjected`], root, 'abc123');
  assert.equal(payload.scriptPath, '/tmp/cursor-skill-bridge-abc123.sh');
  assert.equal(payload.listPath, '/tmp/cursor-skill-bridge-abc123.txt');
  assert.match(payload.script, /chmod a\+x/);
  assert.equal(payload.paths.includes(outside), false);
  assert.equal(payload.paths.includes(inside), true);
  assert.equal(payload.rejected.some((item) => item.includes('newline') || item.includes(outside)), true);

  writeFileSync(payload.listPath, payload.listText);
  writeFileSync(payload.scriptPath, payload.script, { mode: 0o644 });
  const run = spawnSync('/bin/sh', [payload.scriptPath, root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(payload.statusPath, 'utf8').trim(), 'ok');
  assert.equal(statSync(inside).mode & 0o111, 0o111);
  assert.equal(statSync(outside).mode & 0o111, 0);
});
