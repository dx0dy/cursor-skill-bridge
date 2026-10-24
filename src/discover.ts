import path from 'node:path';
import { suggestTarget } from './paths';
import type { CatalogItem, SourceTree } from './types';

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

async function hasManifest(source: SourceTree, directory: string): Promise<boolean> {
  for (const relative of [path.join('.cursor-plugin', 'plugin.json'), 'plugin.json']) {
    try {
      await source.readFile(path.join(directory, relative));
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return false;
}

async function directories(source: SourceTree, directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await source.list(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.kind === 'dir') {
      names.push(entry.name);
      continue;
    }
    if (entry.kind === 'symlink') {
      const stat = await source.statFollow(path.join(directory, entry.name));
      if (stat?.kind === 'dir') names.push(entry.name);
    }
  }
  return names;
}

export async function discoverCursorItems(hostHome: string, source: SourceTree): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  const skillsDir = path.join(hostHome, '.cursor', 'skills');
  for (const name of await directories(source, skillsDir)) {
    const sourcePath = path.join(skillsDir, name);
    items.push({
      id: sourcePath,
      kind: 'skill',
      name,
      source: sourcePath,
      target: suggestTarget(sourcePath, 'skill'),
    });
  }

  const pluginsDir = path.join(hostHome, '.cursor', 'plugins', 'local');
  for (const name of await directories(source, pluginsDir)) {
    const sourcePath = path.join(pluginsDir, name);
    if (!(await hasManifest(source, sourcePath))) continue;
    items.push({
      id: sourcePath,
      kind: 'plugin',
      name,
      source: sourcePath,
      target: suggestTarget(sourcePath, 'plugin'),
    });
  }

  return items;
}
