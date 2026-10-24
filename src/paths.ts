import path from 'node:path';

export const WATCH_FILE_LIMIT = 5000;

export function itemId(source: string): string {
  return source;
}

export function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

export function isDevContainerRemote(remoteName: string | undefined): boolean {
  if (!remoteName) return false;
  return remoteName.toLowerCase().includes('container');
}

export function shouldWatch(fileCount: number, watchEnabled: boolean): boolean {
  return watchEnabled && fileCount > 0 && fileCount <= WATCH_FILE_LIMIT;
}

export function resolveHostPath(input: string, hostHome: string, workspaceRoot?: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return path.normalize(hostHome);
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.resolve(hostHome, trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return path.resolve(workspaceRoot ?? hostHome, trimmed);
}

export function suggestTarget(source: string, kind: 'skill' | 'plugin' | 'folder'): string {
  const base = source.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? source;
  if (kind === 'skill') return `~/.cursor/skills/${base}`;
  return `~/.cursor/plugins/local/${base}`;
}

export function normalizePosix(input: string): string {
  const out: string[] = [];
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

export function containerPath(target: string, containerHome: string): string {
  const home = normalizePosix(containerHome);
  const trimmed = target.trim();
  let raw: string;
  if (trimmed === '~') raw = home;
  else if (trimmed.startsWith('~/')) raw = `${home}${trimmed.slice(1)}`;
  else if (trimmed.startsWith('/')) raw = trimmed;
  else throw new Error(`Destination must start with ~/ or /: ${target}`);
  const normalized = normalizePosix(raw);
  if (normalized !== home && !normalized.startsWith(`${home}/`)) {
    throw new Error(`Destination escapes the container HOME: ${target}`);
  }
  return normalized;
}

export function validateTarget(target: string): string | null {
  try {
    containerPath(target, '/__home__');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function assertInsideHome(containerHome: string, candidate: string): void {
  if (!candidate.startsWith('/')) throw new Error(`Container path must be absolute: ${candidate}`);
  containerPath(candidate, containerHome);
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveLink(parentDir: string, linkText: string): string {
  return path.resolve(parentDir, linkText);
}

export function relativePosix(root: string, full: string): string {
  const relative = path.relative(root, full);
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the source folder: ${full}`);
  }
  return relative.split(path.sep).join('/');
}
