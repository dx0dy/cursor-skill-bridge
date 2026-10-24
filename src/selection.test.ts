import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addFolder,
  applyPickedIds,
  emptyFolders,
  legacyFolders,
  migrateLegacyFolders,
  preserveAuthoredPaths,
  removeFolder,
  resolveFolderSettings,
  resolveItems,
  setUserEnabled,
  setWorkspaceChecked,
} from './selection';
import type { CatalogItem } from './types';

const skill: CatalogItem = {
  id: '/Users/example/.cursor/skills/sequential-best-of-n',
  kind: 'skill',
  name: 'sequential-best-of-n',
  source: '/Users/example/.cursor/skills/sequential-best-of-n',
  target: '~/.cursor/skills/sequential-best-of-n',
};

const plugin: CatalogItem = {
  id: '/Users/example/.cursor/plugins/local/demo',
  kind: 'plugin',
  name: 'demo',
  source: '/Users/example/.cursor/plugins/local/demo',
  target: '~/.cursor/plugins/local/demo',
};

test('discovered items stay off until a user or workspace entry enables them', () => {
  const off = resolveItems([skill], emptyFolders());
  assert.equal(off[0]?.enabled, false);
  assert.equal(off[0]?.scope, 'off');

  const workspace = resolveItems([skill], setWorkspaceChecked(emptyFolders(), skill.id, true));
  assert.equal(workspace[0]?.enabled, true);
  assert.equal(workspace[0]?.scope, 'workspace');

  const user = resolveItems([skill], setUserEnabled(emptyFolders(), skill.id, true));
  assert.equal(user[0]?.enabled, true);
  assert.equal(user[0]?.scope, 'user');
});

test('the same folder list merges user and workspace, and workspace overrides that path', () => {
  const items = resolveItems([skill, plugin], {
    user: [{ path: skill.id, enabled: true }],
    workspace: [
      { path: plugin.id, enabled: true },
      { path: skill.id, enabled: false },
    ],
  });
  const bySource = Object.fromEntries(items.map((item) => [item.source, item]));
  assert.equal(bySource[skill.id]?.enabled, false);
  assert.equal(bySource[plugin.id]?.scope, 'workspace');
});

test('enabled false keeps the path and a custom target', () => {
  const items = resolveItems([skill], {
    user: [{ path: skill.id, enabled: false }],
    workspace: [
      {
        path: '/Users/example/projects/example-plugin',
        target: '~/.cursor/plugins/local/example-plugin',
        enabled: false,
      },
    ],
  });
  const bySource = Object.fromEntries(items.map((item) => [item.source, item]));
  assert.equal(bySource[skill.id]?.enabled, false);
  assert.equal(bySource['/Users/example/projects/example-plugin']?.enabled, false);
  assert.equal(bySource['/Users/example/projects/example-plugin']?.target, '~/.cursor/plugins/local/example-plugin');
});

test('a string is an enabled path and a second entry for the same path replaces it', () => {
  const entries = legacyFolders(
    ['/Users/example/.cursor/skills/old', { path: '/Users/example/.cursor/skills/keep', enabled: true }],
    [{ source: '/Users/example/.cursor/skills/keep', target: '~/.cursor/skills/custom', enabled: false }],
  );
  assert.deepEqual(entries, [
    { path: '/Users/example/.cursor/skills/keep', target: '~/.cursor/skills/custom', enabled: false },
    { path: '/Users/example/.cursor/skills/old', enabled: true },
  ]);
});

test('legacy lists migrate once and do not replace an existing folders value', () => {
  const migrated = migrateLegacyFolders(emptyFolders(), {
    userEnabled: ['/Users/example/.cursor/skills/old'],
    workspaceEnabled: [{ path: '/Users/example/.cursor/skills/time', enabled: false }],
    workspaceExtra: [{ source: '/Users/example/projects/example-plugin', target: '~/.cursor/plugins/local/example-plugin', enabled: true }],
    workspaceState: [{ path: '/from-state', enabled: true }],
  });
  assert.deepEqual(migrated.user, [{ path: '/Users/example/.cursor/skills/old', enabled: true }]);
  assert.equal(migrated.workspace.find((entry) => entry.path === '/Users/example/projects/example-plugin')?.target, '~/.cursor/plugins/local/example-plugin');
  assert.equal(migrated.workspace.find((entry) => entry.path === '/from-state')?.enabled, true);

  const kept = migrateLegacyFolders(
    { user: [{ path: '/already', enabled: true }], workspace: [{ path: '/already-workspace', enabled: true }] },
    { userEnabled: ['/ignored'], workspaceEnabled: ['/ignored-too'] },
  );
  assert.deepEqual(kept.user, [{ path: '/already', enabled: true }]);
  assert.deepEqual(kept.workspace, [{ path: '/already-workspace', enabled: true }]);
});

test('manual folder stores its target and can be removed', () => {
  const added = addFolder(emptyFolders(), { path: skill.source, target: '~/.cursor/skills/custom-name' }, 'workspace');
  const resolved = resolveItems([skill], added);
  assert.equal(resolved[0]?.target, '~/.cursor/skills/custom-name');
  assert.equal(resolved[0]?.scope, 'workspace');

  const removed = resolveItems([skill], removeFolder(added, skill.source));
  assert.equal(removed[0]?.target, skill.target);
  assert.equal(removed[0]?.enabled, false);
});

test('workspace pick edits the workspace list and leaves other user entries', () => {
  const current = resolveItems([skill, plugin], {
    user: [{ path: skill.id, enabled: true }],
    workspace: [{ path: plugin.id, enabled: true }],
  });
  const next = applyPickedIds(current.length ? { user: [{ path: skill.id, enabled: true }], workspace: [{ path: plugin.id, enabled: true }] } : emptyFolders(), current, [], 'workspace');
  const resolved = resolveItems([skill, plugin], next);
  assert.equal(resolved.find((item) => item.id === skill.id)?.scope, 'user');
  assert.equal(resolved.find((item) => item.id === plugin.id)?.enabled, false);
  assert.equal(next.workspace.find((entry) => entry.path === plugin.id)?.enabled, false);
});

test('user pick moves the folder to user settings', () => {
  const current = resolveItems([plugin], setWorkspaceChecked(emptyFolders(), plugin.id, true));
  const next = applyPickedIds({ user: [], workspace: [{ path: plugin.id, enabled: true }] }, current, [plugin.id], 'user');
  const resolved = resolveItems([plugin], next);
  assert.equal(resolved[0]?.scope, 'user');
  assert.equal(next.workspace.some((entry) => entry.path === plugin.id), false);
});

test('a home shortcut in settings matches the discovered folder and is written back unchanged', () => {
  const authored = {
    user: [{ path: '~/.cursor/skills/time', enabled: true }],
    workspace: [] as { path: string; enabled: boolean }[],
  };
  const resolvedSettings = resolveFolderSettings(authored, '/Users/example', '/work/proj');
  assert.deepEqual(resolvedSettings.user, [{ path: '/Users/example/.cursor/skills/time', enabled: true }]);

  const unchecked = setUserEnabled(resolvedSettings, '/Users/example/.cursor/skills/time', false);
  const stored = preserveAuthoredPaths(unchecked, authored, '/Users/example', '/work/proj');
  assert.deepEqual(stored.user, [{ path: '~/.cursor/skills/time', enabled: false }]);
});

test('an other folder keeps only an explicit target', () => {
  const missing = resolveItems([], {
    user: [{ path: '/Users/example/projects/my-tools', enabled: true }],
    workspace: [],
  });
  assert.equal(missing[0]?.kind, 'folder');
  assert.equal(missing[0]?.target, '');

  const explicit = resolveItems([], {
    user: [{ path: '/Users/example/projects/my-tools', target: '~/custom/my-tools', enabled: true }],
    workspace: [],
  });
  assert.equal(explicit[0]?.target, '~/custom/my-tools');
});

test('checking the same workspace folder twice does not duplicate it', () => {
  const once = setWorkspaceChecked(emptyFolders(), '/same', true);
  const twice = setWorkspaceChecked(once, '/same', true);
  assert.deepEqual(twice.workspace, [{ path: '/same', enabled: true }]);
});
