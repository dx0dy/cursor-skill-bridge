import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WATCH_FILE_LIMIT,
  containerPath,
  isDevContainerRemote,
  isExecutableMode,
  isInside,
  itemId,
  resolveHostPath,
  shouldWatch,
  suggestTarget,
  validateTarget,
} from './paths';

test('containerPath uses the container home, not a hardcoded host home', () => {
  assert.equal(
    containerPath('~/.cursor/skills/sequential-best-of-n', '/home/vscode'),
    '/home/vscode/.cursor/skills/sequential-best-of-n',
  );
  assert.equal(
    containerPath('~/.cursor/plugins/local/example-plugin', '/home/vscode'),
    '/home/vscode/.cursor/plugins/local/example-plugin',
  );
  assert.equal(containerPath('~/tools/demo', '/Users/example'), '/Users/example/tools/demo');
});

test('host path accepts a home shortcut and a workspace-relative path', () => {
  assert.equal(resolveHostPath('~/.cursor/skills/time', '/Users/example', '/work/proj'), '/Users/example/.cursor/skills/time');
  assert.equal(resolveHostPath('~', '/Users/example', '/work/proj'), '/Users/example');
  assert.equal(resolveHostPath('/Users/example/.cursor/plugins/local/demo', '/Users/example', '/work/proj'), '/Users/example/.cursor/plugins/local/demo');
  assert.equal(resolveHostPath('my-tools', '/Users/example', '/work/proj'), '/work/proj/my-tools');
  assert.equal(resolveHostPath('my-tools', '/Users/example'), '/Users/example/my-tools');
});

test('containerPath rejects paths that escape the container home', () => {
  assert.throws(() => containerPath('~/../../etc/passwd', '/home/vscode'));
  assert.throws(() => containerPath('/etc/passwd', '/home/vscode'));
  assert.throws(() => containerPath('relative/skills', '/home/vscode'));
});

test('suggestTarget maps skills and plugins to the Cursor directories', () => {
  assert.equal(
    suggestTarget('/Users/example/.cursor/skills/sequential-best-of-n', 'skill'),
    '~/.cursor/skills/sequential-best-of-n',
  );
  assert.equal(
    suggestTarget('/Users/example/projects/example-plugin', 'plugin'),
    '~/.cursor/plugins/local/example-plugin',
  );
});

test('executable mode is any execute bit', () => {
  assert.equal(isExecutableMode(0o644), false);
  assert.equal(isExecutableMode(0o755), true);
  assert.equal(isExecutableMode(0o700), true);
});

test('isInside is lexical and stays inside the source root', () => {
  assert.equal(isInside('/src/skill', '/src/skill/scripts/now.sh'), true);
  assert.equal(isInside('/src/skill', '/src/skill'), true);
  assert.equal(isInside('/src/skill', '/etc/passwd'), false);
  assert.equal(isInside('/src/skill', '/src/skill/../other'), false);
});

test('item id is the absolute source path', () => {
  assert.equal(itemId('/Users/example/.cursor/skills/time'), '/Users/example/.cursor/skills/time');
});

test('validateTarget accepts ~/ destinations and rejects escapes', () => {
  assert.equal(validateTarget('~/.cursor/plugins/local/demo'), null);
  assert.equal(typeof validateTarget('~/../../etc'), 'string');
});

test('watch only when enabled and the tree is within the file limit', () => {
  assert.equal(shouldWatch(10, true), true);
  assert.equal(shouldWatch(0, true), false);
  assert.equal(shouldWatch(WATCH_FILE_LIMIT, true), true);
  assert.equal(shouldWatch(WATCH_FILE_LIMIT + 1, true), false);
  assert.equal(shouldWatch(10, false), false);
});

test('dev container remote names are recognized', () => {
  assert.equal(isDevContainerRemote('dev-container'), true);
  assert.equal(isDevContainerRemote('attached-container'), true);
  assert.equal(isDevContainerRemote('ssh-remote'), false);
  assert.equal(isDevContainerRemote(undefined), false);
});
