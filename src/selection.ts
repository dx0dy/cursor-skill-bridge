import { resolveHostPath, suggestTarget } from './paths';
import type { CatalogItem, ResolvedItem } from './types';

export type SettingScope = 'user' | 'workspace';

export interface FolderEntry {
  path: string;
  target?: string;
  enabled: boolean;
}

export interface FolderSettings {
  user: FolderEntry[];
  workspace: FolderEntry[];
}

export interface LegacyFolders {
  userEnabled?: readonly unknown[];
  userExtra?: readonly unknown[];
  workspaceEnabled?: readonly unknown[];
  workspaceExtra?: readonly unknown[];
  userState?: readonly FolderEntry[];
  workspaceState?: readonly FolderEntry[];
}

export function emptyFolders(): FolderSettings {
  return { user: [], workspace: [] };
}

export function resolveFolderSettings(settings: FolderSettings, hostHome: string, workspaceRoot?: string): FolderSettings {
  const resolveEntry = (entry: FolderEntry): FolderEntry => ({
    ...entry,
    path: resolveHostPath(entry.path, hostHome, workspaceRoot),
  });
  return { user: settings.user.map(resolveEntry), workspace: settings.workspace.map(resolveEntry) };
}

export function preserveAuthoredPaths(
  resolved: FolderSettings,
  authored: FolderSettings,
  hostHome: string,
  workspaceRoot?: string,
): FolderSettings {
  const authoredByResolved = new Map<string, string>();
  for (const entry of [...authored.user, ...authored.workspace]) {
    authoredByResolved.set(resolveHostPath(entry.path, hostHome, workspaceRoot), entry.path);
  }
  const restore = (entry: FolderEntry): FolderEntry => {
    const path = authoredByResolved.get(entry.path);
    return path && path !== entry.path ? { ...entry, path } : entry;
  };
  return { user: resolved.user.map(restore), workspace: resolved.workspace.map(restore) };
}

export function parseFolderEntry(value: unknown): FolderEntry | null {
  if (typeof value === 'string') {
    const path = value.trim();
    return path ? { path, enabled: true } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as { path?: unknown; source?: unknown; target?: unknown; enabled?: unknown };
  const path = String(record.path ?? record.source ?? '').trim();
  if (!path) return null;
  const target = typeof record.target === 'string' ? record.target.trim() : '';
  return target ? { path, target, enabled: record.enabled !== false } : { path, enabled: record.enabled !== false };
}

export function folderEntries(values: readonly unknown[] | undefined): FolderEntry[] {
  const map = new Map<string, FolderEntry>();
  for (const value of values ?? []) {
    const parsed = parseFolderEntry(value);
    if (parsed) map.set(parsed.path, parsed);
  }
  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function legacyFolders(enabled: readonly unknown[] | undefined, extra: readonly unknown[] | undefined): FolderEntry[] {
  return folderEntries([...(enabled ?? []), ...(extra ?? [])]);
}

export function migrateLegacyFolders(current: FolderSettings, legacy: LegacyFolders): FolderSettings {
  return {
    user: current.user.length > 0 ? current.user : folderEntries([...(legacy.userState ?? []), ...legacyFolders(legacy.userEnabled, legacy.userExtra)]),
    workspace:
      current.workspace.length > 0
        ? current.workspace
        : folderEntries([...(legacy.workspaceState ?? []), ...legacyFolders(legacy.workspaceEnabled, legacy.workspaceExtra)]),
  };
}

function withTarget(path: string, enabled: boolean, target?: string): FolderEntry {
  const trimmed = target?.trim();
  return trimmed ? { path, target: trimmed, enabled } : { path, enabled };
}

function upsert(list: readonly FolderEntry[], entry: FolderEntry): FolderEntry[] {
  return folderEntries([...list.filter((item) => item.path !== entry.path), entry]);
}

export function setWorkspaceChecked(settings: FolderSettings, id: string, checked: boolean, target?: string): FolderSettings {
  const previous = settings.workspace.find((item) => item.path === id);
  return { ...settings, workspace: upsert(settings.workspace, withTarget(id, checked, target ?? previous?.target)) };
}

export function setUserEnabled(settings: FolderSettings, id: string, enabled: boolean, target?: string): FolderSettings {
  const previous = settings.user.find((item) => item.path === id) ?? settings.workspace.find((item) => item.path === id);
  return {
    user: upsert(settings.user, withTarget(id, enabled, target ?? previous?.target)),
    workspace: settings.workspace.filter((item) => item.path !== id),
  };
}

export function applyPickedIds(
  settings: FolderSettings,
  items: ReadonlyArray<Pick<ResolvedItem, 'id' | 'scope' | 'origin' | 'target'>>,
  pickedIds: readonly string[],
  scope: SettingScope,
): FolderSettings {
  const picked = new Set(pickedIds);
  let next = settings;
  for (const item of items) {
    const target = item.origin === 'manual' ? item.target : undefined;
    const selected = picked.has(item.id);
    if (scope === 'user') {
      if (selected) next = setUserEnabled(next, item.id, true, target);
      else if (next.user.some((entry) => entry.path === item.id)) next = setUserEnabled(next, item.id, false, target);
      continue;
    }
    if (selected) next = setWorkspaceChecked(next, item.id, true, target);
    else if (item.scope === 'workspace' || next.workspace.some((entry) => entry.path === item.id)) {
      next = setWorkspaceChecked(next, item.id, false, target);
    }
  }
  return next;
}

export function addFolder(settings: FolderSettings, folder: { path: string; target: string }, scope: SettingScope): FolderSettings {
  return scope === 'user'
    ? setUserEnabled(settings, folder.path, true, folder.target)
    : setWorkspaceChecked(settings, folder.path, true, folder.target);
}

export function removeFolder(settings: FolderSettings, path: string): FolderSettings {
  return {
    user: settings.user.filter((item) => item.path !== path),
    workspace: settings.workspace.filter((item) => item.path !== path),
  };
}

function baseName(source: string): string {
  return source.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? source;
}

function kindFor(source: string, found?: CatalogItem): CatalogItem['kind'] {
  if (found) return found.kind;
  const normalized = source.replace(/\\/g, '/');
  if (normalized.includes('/.cursor/skills/')) return 'skill';
  if (normalized.includes('/.cursor/plugins/local/')) return 'plugin';
  return 'folder';
}

export function resolveItems(discovered: readonly CatalogItem[], settings: FolderSettings): ResolvedItem[] {
  const user = new Map(settings.user.map((entry) => [entry.path, entry]));
  const workspace = new Map(settings.workspace.map((entry) => [entry.path, entry]));
  const foundBySource = new Map(discovered.map((item) => [item.source, item]));
  const ids = new Set<string>([...foundBySource.keys(), ...user.keys(), ...workspace.keys()]);
  const kindOrder = { skill: 0, plugin: 1, folder: 2 };
  return [...ids]
    .map((id) => {
      const found = foundBySource.get(id);
      const userEntry = user.get(id);
      const workspaceEntry = workspace.get(id);
      const kind = kindFor(id, found);
      const explicit = (workspaceEntry?.target || userEntry?.target || '').trim();
      const target = explicit || found?.target || (kind === 'folder' ? '' : suggestTarget(id, kind));
      let scope: ResolvedItem['scope'] = 'off';
      if (workspaceEntry?.enabled === false) scope = 'off';
      else if (userEntry?.enabled) scope = 'user';
      else if (workspaceEntry?.enabled) scope = 'workspace';
      return {
        id,
        kind,
        name: found?.name ?? baseName(id),
        source: id,
        target,
        enabled: scope !== 'off',
        scope,
        origin: found ? ('discovered' as const) : ('manual' as const),
      };
    })
    .sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}
