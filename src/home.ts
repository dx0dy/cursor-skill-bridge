import { randomBytes } from 'node:crypto';

export interface HomeProbe {
  run(command: string, args: string[]): Promise<number>;
  readFile(absolutePath: string): Promise<Uint8Array | null>;
  remove(absolutePath: string): Promise<void>;
  exists(absolutePath: string): Promise<boolean>;
}

function probePath(nonce: string): string {
  return `/tmp/cursor-skill-bridge-${nonce}.home`;
}

export async function resolveContainerHome(probe: HomeProbe): Promise<string> {
  const file = probePath(randomBytes(8).toString('hex'));
  try {
    const code = await probe.run('/bin/sh', ['-c', `printf '%s' "$HOME" > '${file}'`]);
    if (code === 0) {
      const bytes = await probe.readFile(file);
      const value = bytes ? Buffer.from(bytes).toString('utf8').trim() : '';
      if (value.startsWith('/') && !value.includes('\n') && (await probe.exists(value))) {
        return value.replace(/\/+$/, '');
      }
    }
  } finally {
    await probe.remove(file).catch(() => undefined);
  }
  if (await probe.exists('/home/vscode')) return '/home/vscode';
  if (await probe.exists('/root')) return '/root';
  throw new Error('Could not determine the container HOME. The shell probe returned no path, and /home/vscode and /root are unavailable.');
}
