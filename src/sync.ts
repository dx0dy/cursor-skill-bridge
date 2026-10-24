import path from 'node:path';
import { assertInsideHome, containerPath, isExecutableMode, isInside, relativePosix, resolveLink } from './paths';
import type { Destination, ResolvedItem, SourceEntry, SourceTree, SyncReport } from './types';

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function joinDest(root: string, relative: string): string {
  const base = root.replace(/\/+$/, '');
  return relative ? `${base}/${relative}` : base;
}

async function copyTree(
  sourceRoot: string,
  destRoot: string,
  source: SourceTree,
  dest: Destination,
  report: SyncReport,
): Promise<void> {
  assertInsideHome(destRoot, destRoot);
  await dest.mkdir(destRoot);

  const write = async (relative: string, bytes: Uint8Array, executable: boolean): Promise<void> => {
    const destination = joinDest(destRoot, relative);
    assertInsideHome(destRoot, destination);
    const parent = destination.slice(0, destination.lastIndexOf('/'));
    if (parent) await dest.mkdir(parent);
    const current = await dest.readFile(destination);
    if (current && sameBytes(current, bytes)) report.unchanged += 1;
    else {
      await dest.writeFile(destination, bytes);
      report.copied += 1;
    }
    report.fileCount += 1;
    if (executable) report.executables.push(destination);
  };

  const visit = async (directory: string): Promise<void> => {
    const entries = [...(await source.list(directory))].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativePosix(sourceRoot, absolute);
      if (entry.name === '.git') {
        report.skipped.push({ path: relative, reason: 'git' });
        continue;
      }
      if (entry.kind === 'dir') {
        await dest.mkdir(joinDest(destRoot, relative));
        await visit(absolute);
        continue;
      }
      if (entry.kind === 'symlink') {
        await copyLink(directory, absolute, relative, entry);
        continue;
      }
      if (entry.kind !== 'file') {
        report.skipped.push({ path: relative, reason: 'unsupported' });
        continue;
      }
      await write(relative, await source.readFile(absolute), isExecutableMode(entry.mode));
    }
  };

  const copyLink = async (parent: string, absolute: string, relative: string, _entry: SourceEntry): Promise<void> => {
    const resolved = resolveLink(parent, await source.readlink(absolute));
    if (!isInside(sourceRoot, resolved)) {
      report.skipped.push({ path: relative, reason: 'symlink-escapes' });
      return;
    }
    const stat = await source.statFollow(resolved);
    if (!stat) {
      report.skipped.push({ path: relative, reason: 'broken-symlink' });
      return;
    }
    if (stat.kind === 'dir') {
      report.skipped.push({ path: relative, reason: 'directory-symlink' });
      return;
    }
    if (stat.kind !== 'file') {
      report.skipped.push({ path: relative, reason: 'unsupported' });
      return;
    }
    await write(relative, await source.readFile(resolved), isExecutableMode(stat.mode));
  };

  await visit(sourceRoot);
}

export async function syncItems(
  items: ResolvedItem[],
  source: SourceTree,
  dest: Destination,
  containerHome: string,
): Promise<SyncReport> {
  const report: SyncReport = {
    copied: 0,
    unchanged: 0,
    skipped: [],
    executables: [],
    errors: [],
    warnings: [],
    fileCount: 0,
  };
  for (const item of items) {
    if (!item.enabled) continue;
    try {
      if (!item.target.trim()) {
        report.warnings.push({ source: item.source, message: `No target for ${item.source}. Set target to the container path.` });
        continue;
      }
      const root = await source.statFollow(item.source);
      if (!root) {
        report.warnings.push({ source: item.source, message: `Source folder does not exist: ${item.source}` });
        continue;
      }
      if (root.kind !== 'dir') {
        report.warnings.push({ source: item.source, message: `Source is not a folder: ${item.source}` });
        continue;
      }
      const destination = containerPath(item.target, containerHome);
      await copyTree(item.source, destination, source, dest, report);
    } catch (error) {
      report.errors.push({
        source: item.source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  report.executables.sort();
  return report;
}
