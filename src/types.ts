export interface SourceEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  mode: number;
}

export interface SourceTree {
  list(absolutePath: string): Promise<SourceEntry[]>;
  readFile(absolutePath: string): Promise<Uint8Array>;
  readlink(absolutePath: string): Promise<string>;
  statFollow(absolutePath: string): Promise<SourceEntry | null>;
}

export interface Destination {
  readFile(absolutePath: string): Promise<Uint8Array | null>;
  writeFile(absolutePath: string, bytes: Uint8Array): Promise<void>;
  mkdir(absolutePath: string): Promise<void>;
}

export interface CatalogItem {
  id: string;
  kind: 'skill' | 'plugin' | 'folder';
  name: string;
  source: string;
  target: string;
}

export interface ResolvedItem extends CatalogItem {
  enabled: boolean;
  scope: 'user' | 'workspace' | 'off';
  origin: 'discovered' | 'manual';
}

export interface SyncSkip {
  path: string;
  reason: string;
}

export interface SyncReport {
  copied: number;
  unchanged: number;
  skipped: SyncSkip[];
  executables: string[];
  errors: { source: string; message: string }[];
  warnings: { source: string; message: string }[];
  fileCount: number;
}
