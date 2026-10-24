import fs from 'node:fs/promises';
import path from 'node:path';
import type { SourceEntry, SourceTree } from './types';

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

function kindFromStat(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): SourceEntry['kind'] {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'dir';
  if (stats.isFile()) return 'file';
  return 'other';
}

export function createNodeSourceTree(): SourceTree {
  return {
    async list(absolutePath: string): Promise<SourceEntry[]> {
      const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
      const entries: SourceEntry[] = [];
      for (const dirent of dirents) {
        const full = path.join(absolutePath, dirent.name);
        const stats = await fs.lstat(full);
        let kind: SourceEntry['kind'] = 'other';
        if (dirent.isSymbolicLink()) kind = 'symlink';
        else if (dirent.isDirectory()) kind = 'dir';
        else if (dirent.isFile()) kind = 'file';
        entries.push({ name: dirent.name, kind, mode: stats.mode });
      }
      return entries;
    },
    readFile(absolutePath: string): Promise<Uint8Array> {
      return fs.readFile(absolutePath);
    },
    readlink(absolutePath: string): Promise<string> {
      return fs.readlink(absolutePath);
    },
    async statFollow(absolutePath: string): Promise<SourceEntry | null> {
      try {
        const stats = await fs.stat(absolutePath);
        return { name: path.basename(absolutePath), kind: kindFromStat(stats), mode: stats.mode };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
  };
}
