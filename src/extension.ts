import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoverCursorItems } from './discover';
import { resolveContainerHome } from './home';
import { createNodeSourceTree } from './nodeSource';
import { WATCH_FILE_LIMIT, isDevContainerRemote, resolveHostPath, shouldWatch, suggestTarget, validateTarget } from './paths';
import { deleteTemp, readTemp, runRemoteProcess, applyExecutableBits, createRemoteDestination } from './remote';
import {
  addFolder,
  applyPickedIds,
  folderEntries,
  migrateLegacyFolders,
  preserveAuthoredPaths,
  removeFolder,
  resolveFolderSettings,
  resolveItems,
  setUserEnabled,
  setWorkspaceChecked,
  type FolderEntry,
  type FolderSettings,
  type SettingScope,
} from './selection';
import { syncItems } from './sync';
import { BridgeTree, ItemNode } from './tree';
import type { ResolvedItem } from './types';

const EXTENSION_ID = 'dx0dy.cursor-skill-bridge';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') return undefined;
  return folder.uri.fsPath;
}

function readAuthoredSettings(): FolderSettings {
  const folders = vscode.workspace.getConfiguration('cursorSkillBridge').inspect<unknown[]>('folders');
  return {
    user: folderEntries(folders?.globalValue),
    workspace: folderEntries([...(folders?.workspaceValue ?? []), ...(folders?.workspaceFolderValue ?? [])]),
  };
}

function readSettings(): { folders: FolderSettings; autoSync: boolean; watch: boolean } {
  const config = vscode.workspace.getConfiguration('cursorSkillBridge');
  return {
    folders: resolveFolderSettings(readAuthoredSettings(), os.homedir(), localWorkspaceRoot()),
    autoSync: config.get<boolean>('autoSync', true),
    watch: config.get<boolean>('watch', true),
  };
}

function rememberedFolders(values: readonly string[], suppressed: readonly string[], manuals: readonly { source: string; target: string }[]): FolderEntry[] {
  return [
    ...values.map((path) => ({ path, enabled: !suppressed.includes(path) })),
    ...manuals.map((folder) => ({ path: folder.source, target: folder.target, enabled: true })),
  ];
}

async function migrateStoredFolders(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorSkillBridge');
  const folders = config.inspect<unknown[]>('folders');
  const project = config.inspect<unknown[]>('projectEnabled');
  const globalEnabled = config.inspect<unknown[]>('globalEnabled');
  const extra = config.inspect<unknown[]>('extraFolders');
  const current = readAuthoredSettings();
  const next = migrateLegacyFolders(current, {
    userEnabled: globalEnabled?.globalValue,
    userExtra: extra?.globalValue,
    workspaceEnabled: [...(project?.workspaceValue ?? []), ...(project?.workspaceFolderValue ?? [])],
    workspaceExtra: [...(extra?.workspaceValue ?? []), ...(extra?.workspaceFolderValue ?? [])],
    userState: rememberedFolders(
      context.globalState.get<string[]>('globalEnabled', []),
      context.globalState.get<string[]>('globalSuppressed', []),
      context.globalState.get<{ source: string; target: string }[]>('manualFolders', []),
    ),
    workspaceState: rememberedFolders(
      context.workspaceState.get<string[]>('projectEnabled', []),
      context.workspaceState.get<string[]>('projectSuppressed', []),
      context.workspaceState.get<{ source: string; target: string }[]>('manualFolders', []),
    ),
  });
  if (current.workspace.length === 0 && next.workspace.length > 0) {
    await config.update('folders', next.workspace, vscode.ConfigurationTarget.Workspace);
  }
  if (current.user.length === 0 && next.user.length > 0) {
    await config.update('folders', next.user, vscode.ConfigurationTarget.Global);
  }
  if (project?.workspaceValue !== undefined) await config.update('projectEnabled', undefined, vscode.ConfigurationTarget.Workspace);
  if (globalEnabled?.globalValue !== undefined) await config.update('globalEnabled', undefined, vscode.ConfigurationTarget.Global);
  if (extra?.workspaceValue !== undefined) await config.update('extraFolders', undefined, vscode.ConfigurationTarget.Workspace);
  if (extra?.globalValue !== undefined) await config.update('extraFolders', undefined, vscode.ConfigurationTarget.Global);
  await context.workspaceState.update('projectEnabled', undefined);
  await context.workspaceState.update('projectSuppressed', undefined);
  await context.workspaceState.update('manualFolders', undefined);
  await context.globalState.update('globalEnabled', undefined);
  await context.globalState.update('globalSuppressed', undefined);
  await context.globalState.update('manualFolders', undefined);
}

async function writeFolders(settings: FolderSettings): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorSkillBridge');
  const inspected = config.inspect<unknown[]>('folders');
  const write = async (entries: readonly FolderEntry[], target: vscode.ConfigurationTarget, existed: boolean): Promise<void> => {
    if (entries.length === 0) {
      if (existed) await config.update('folders', undefined, target);
      return;
    }
    await config.update('folders', entries, target);
  };
  await write(settings.workspace, vscode.ConfigurationTarget.Workspace, inspected?.workspaceValue !== undefined);
  await write(settings.user, vscode.ConfigurationTarget.Global, inspected?.globalValue !== undefined);
}

async function inferKind(source: string): Promise<'skill' | 'plugin'> {
  for (const relative of [path.join('.cursor-plugin', 'plugin.json'), 'plugin.json']) {
    try {
      await fsp.access(path.join(source, relative));
      return 'plugin';
    } catch {
      // The folder is not a plugin manifest at this path.
    }
  }
  try {
    await fsp.access(path.join(source, 'SKILL.md'));
    return 'skill';
  } catch {
    return path.basename(path.dirname(source)) === 'skills' ? 'skill' : 'plugin';
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Cursor Skill Bridge');
  const tree = new BridgeTree();
  const view = vscode.window.createTreeView('cursorSkillBridge.view', { treeDataProvider: tree, showCollapseAll: true });
  const log = (message: string) => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const runsOnHost = extension?.extensionKind !== vscode.ExtensionKind.Workspace;
  let running = false;
  let queued = false;
  let suppressWatchUntil = 0;
  let watchers: fs.FSWatcher[] = [];
  let watchTimer: NodeJS.Timeout | undefined;

  const stopWatch = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = undefined;
  };

  const remoteFolder = (): vscode.Uri | undefined => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder || folder.scheme === 'file') return undefined;
    return folder;
  };

  const catalog = async (): Promise<ResolvedItem[]> => {
    const discovered = runsOnHost ? await discoverCursorItems(os.homedir(), createNodeSourceTree()) : [];
    return resolveItems(discovered, readSettings().folders);
  };

  const refreshTree = async (): Promise<ResolvedItem[]> => {
    try {
      const items = await catalog();
      tree.show(items);
      return items;
    } catch (error) {
      log(`Could not read skills/plugins on the host: ${messageOf(error)}`);
      output.show(true);
      return [];
    }
  };

  const restartWatch = (items: ResolvedItem[], fileCount: number) => {
    stopWatch();
    const enabled = items.filter((item) => item.enabled);
    if (!shouldWatch(fileCount, readSettings().watch)) {
      if (readSettings().watch && fileCount > WATCH_FILE_LIMIT) {
        log(`Watch disabled: ${fileCount} files, limit ${WATCH_FILE_LIMIT}. Sync remains on connect and via Cursor Skill Bridge: Sync Cursor Skills/Plugins.`);
      }
      return;
    }
    for (const item of enabled) {
      try {
        const watcher = fs.watch(item.source, { recursive: true }, (_event, filename) => {
          if (Date.now() < suppressWatchUntil) return;
          if (typeof filename === 'string' && filename.split(/[\\/]/).includes('.git')) return;
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(() => requestSync('watch'), 400);
        });
        watcher.on('error', (error) => {
          log(`Watch stopped for ${item.source}: ${error.message}`);
          watcher.close();
        });
        watchers.push(watcher);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
        if (code === 'ENOENT') log(`Warning ${item.source}: Source folder does not exist: ${item.source}`);
        else log(`Could not watch ${item.source}: ${messageOf(error)}. Host changes will be picked up on the next connection or by command.`);
      }
    }
  };

  const syncNow = async (reason: string): Promise<void> => {
    suppressWatchUntil = Date.now() + 120_000;
    if (watchTimer) clearTimeout(watchTimer);
    try {
      await runSync(reason);
    } finally {
      suppressWatchUntil = Date.now() + 2_000;
    }
  };

  const runSync = async (reason: string): Promise<void> => {
    log(`Sync (${reason}). extensionKind=${runsOnHost ? 'ui' : 'workspace'}, remote=${vscode.env.remoteName || 'none'}`);
    if (!runsOnHost && vscode.env.remoteName) {
      const text = 'Cursor Skill Bridge is running inside the Dev Container. Install the VSIX on the host and check Developer: Show Running Extensions.';
      log(text);
      void vscode.window.showErrorMessage(text);
      return;
    }
    if (!isDevContainerRemote(vscode.env.remoteName)) {
      log('The window is not connected to a Dev Container.');
      if (reason === 'manual') {
        void vscode.window.showInformationMessage('Open a folder in a Dev Container to sync skills and plugins.');
      }
      return;
    }
    const folder = remoteFolder();
    if (!folder) {
      log('No remote workspace URI. Writing into the container is unavailable.');
      output.show(true);
      return;
    }
    const items = await refreshTree();
    const enabled = items.filter((item) => item.enabled);
    if (enabled.length === 0) {
      log('No items selected.');
      stopWatch();
      if (reason === 'manual') void vscode.window.showInformationMessage('Select skills or plugins in the Cursor Skills/Plugins view.');
      return;
    }
    let home: string;
    try {
      home = await resolveContainerHome({
        run: runRemoteProcess,
        readFile: (absolutePath) => readTemp(folder, absolutePath),
        remove: (absolutePath) => deleteTemp(folder, absolutePath),
        exists: async (absolutePath) => {
          try {
            await vscode.workspace.fs.stat(folder.with({ path: absolutePath }));
            return true;
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      log(`Container HOME: ${messageOf(error)}`);
      output.show(true);
      return;
    }
    log(`Container HOME: ${home}`);
    for (const item of enabled) log(`${item.source} → ${item.target}`);
    const report = await syncItems(enabled, createNodeSourceTree(), createRemoteDestination(folder, home), home);
    for (const warning of report.warnings) log(`Warning ${warning.source}: ${warning.message}`);
    for (const error of report.errors) log(`Error ${error.source}: ${error.message}`);
    let chmodCount = 0;
    if (report.executables.length > 0) {
      try {
        chmodCount = await applyExecutableBits(folder, home, report.executables, log);
        log(`chmod +x: ${chmodCount}`);
      } catch (error) {
        log(`Could not preserve the executable bit: ${messageOf(error)}`);
        report.errors.push({ source: 'chmod', message: messageOf(error) });
      }
    }
    const skipped = report.skipped.length;
    log(`Done: copied ${report.copied}, unchanged ${report.unchanged}, skipped ${skipped}, errors ${report.errors.length}.`);
    restartWatch(items, report.fileCount);
    if (report.errors.length > 0) {
      output.show(true);
      void vscode.window.showErrorMessage('Cursor skills/plugins sync finished with errors. See Output → Cursor Skill Bridge.');
      return;
    }
    if (reason === 'manual') {
      void vscode.window.showInformationMessage(
        `Sync finished: copied ${report.copied}, unchanged ${report.unchanged}, chmod ${chmodCount}.`,
      );
    }
  };

  const requestSync = (reason: string): void => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    void syncNow(reason)
      .catch((error: unknown) => {
        log(`Sync failed: ${messageOf(error)}`);
        output.show(true);
      })
      .finally(() => {
        running = false;
        if (queued) {
          queued = false;
          requestSync('queued');
        }
      });
  };

  const persist = async (settings: FolderSettings): Promise<void> => {
    const stored = preserveAuthoredPaths(settings, readAuthoredSettings(), os.homedir(), localWorkspaceRoot());
    try {
      await writeFolders(stored);
    } catch (error) {
      log(`Could not write settings: ${messageOf(error)}`);
      void vscode.window.showErrorMessage(`Could not write settings: ${messageOf(error)}`);
      return;
    }
    await refreshTree();
    if (isDevContainerRemote(vscode.env.remoteName)) requestSync('selection');
  };

  context.subscriptions.push(
    output,
    view,
    { dispose: stopWatch },
    vscode.commands.registerCommand('cursorSkillBridge.pickItems', async () => {
      const items = await refreshTree();
      if (items.length === 0) {
        const home = os.homedir();
        const choice = await vscode.window.showInformationMessage(
          runsOnHost
            ? `Nothing found on the host in ${home}/.cursor/skills or ${home}/.cursor/plugins/local.`
            : 'The extension is running inside the container and cannot see host directories. Install the VSIX on the host.',
          'Add folder',
        );
        if (choice) await vscode.commands.executeCommand('cursorSkillBridge.addFolder');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        items.map((item) => ({
          label: `${item.kind === 'skill' ? '$(book)' : item.kind === 'plugin' ? '$(extensions)' : '$(folder)'} ${item.name}`,
          description: item.enabled ? item.scope : 'off',
          detail: `${item.source} → ${item.target}`,
          picked: item.enabled,
          id: item.id,
        })),
        {
          canPickMany: true,
          ignoreFocusOut: true,
          title: 'Local skills and plugins',
          placeHolder: 'Select what to copy into the Dev Container',
        },
      );
      if (!selected) return;
      let scope: SettingScope = 'workspace';
      if (selected.length > 0) {
        const target = await vscode.window.showQuickPick(
          [
            { label: 'Workspace', description: '.vscode/settings.json, this project only', scope: 'workspace' as const },
            { label: 'User', description: 'User settings, every workspace', scope: 'user' as const },
          ],
          { placeHolder: 'Where to enable the selection', ignoreFocusOut: true, title: 'Local skills and plugins' },
        );
        if (!target) return;
        scope = target.scope;
      }
      await persist(applyPickedIds(readSettings().folders, items, selected.map((item) => item.id), scope));
    }),
    vscode.commands.registerCommand('cursorSkillBridge.sync', () => requestSync('manual')),
    vscode.commands.registerCommand('cursorSkillBridge.refresh', () => void refreshTree()),
    vscode.commands.registerCommand('cursorSkillBridge.enableGlobally', async (node?: ItemNode) => {
      if (!(node instanceof ItemNode)) {
        void vscode.window.showInformationMessage('Select an item in the Cursor Skills/Plugins view.');
        return;
      }
      await persist(setUserEnabled(readSettings().folders, node.item.id, true, node.item.origin === 'manual' ? node.item.target : undefined));
    }),
    vscode.commands.registerCommand('cursorSkillBridge.removeFolder', async (node?: ItemNode) => {
      if (!(node instanceof ItemNode) || node.item.origin !== 'manual') return;
      await persist(removeFolder(readSettings().folders, node.item.source));
    }),
    vscode.commands.registerCommand('cursorSkillBridge.addFolder', async () => {
      const scope = await vscode.window.showQuickPick(
        [
          { label: 'Workspace', description: '.vscode/settings.json, this project only', scope: 'workspace' as const },
          { label: 'User', description: 'User settings, every workspace', scope: 'user' as const },
        ],
        { placeHolder: 'Where to sync the folder', ignoreFocusOut: true },
      );
      if (!scope) return;
      const typed = await vscode.window.showInputBox({
        prompt: 'Host folder. ~ is your home directory. A relative path uses a locally opened workspace.',
        ignoreFocusOut: true,
      });
      if (!typed) return;
      const source = resolveHostPath(typed, os.homedir(), localWorkspaceRoot());
      try {
        const stat = await fsp.stat(source);
        if (!stat.isDirectory()) throw new Error('Not a directory');
      } catch (error) {
        void vscode.window.showErrorMessage(`Folder is not available: ${messageOf(error)}`);
        return;
      }
      const target = await vscode.window.showInputBox({
        prompt: "Path inside the container. ~ is the container user's HOME.",
        value: suggestTarget(source, await inferKind(source)),
        ignoreFocusOut: true,
      });
      if (!target) return;
      const problem = validateTarget(target);
      if (problem) {
        void vscode.window.showErrorMessage(problem);
        return;
      }
      await persist(addFolder(readSettings().folders, { path: typed.trim(), target }, scope.scope));
    }),
    view.onDidChangeCheckboxState(async (event) => {
      let settings = readSettings().folders;
      for (const [element, checkbox] of event.items) {
        if (!(element instanceof ItemNode)) continue;
        settings = setWorkspaceChecked(
          settings,
          element.item.id,
          checkbox === vscode.TreeItemCheckboxState.Checked,
          element.item.origin === 'manual' ? element.item.target : undefined,
        );
      }
      await persist(settings);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('cursorSkillBridge')) return;
      void refreshTree();
      if (isDevContainerRemote(vscode.env.remoteName)) requestSync('settings');
    }),
  );

  log(`Activated. Host: ${os.homedir()}. extensionKind=${runsOnHost ? 'ui' : 'workspace'}.`);
  try {
    await migrateStoredFolders(context);
  } catch (error) {
    log(`Could not migrate old settings: ${messageOf(error)}`);
  }
  void refreshTree();
  if (readSettings().autoSync && isDevContainerRemote(vscode.env.remoteName)) requestSync('startup');
}

export function deactivate(): void {}
