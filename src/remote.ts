import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { buildChmodPayload, isBridgeTempPath } from './chmod';
import { assertInsideHome } from './paths';
import type { Destination } from './types';

export function remoteUri(workspaceFolder: vscode.Uri, absolutePath: string): vscode.Uri {
  return workspaceFolder.with({ path: absolutePath });
}

function isNotFound(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) return error.code === 'FileNotFound';
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'FileNotFound';
}

export function createRemoteDestination(workspaceFolder: vscode.Uri, containerHome: string): Destination {
  const uri = (absolutePath: string) => {
    assertInsideHome(containerHome, absolutePath);
    return remoteUri(workspaceFolder, absolutePath);
  };
  return {
    async readFile(absolutePath: string): Promise<Uint8Array | null> {
      try {
        return await vscode.workspace.fs.readFile(uri(absolutePath));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async writeFile(absolutePath: string, bytes: Uint8Array): Promise<void> {
      await vscode.workspace.fs.writeFile(uri(absolutePath), bytes);
    },
    async mkdir(absolutePath: string): Promise<void> {
      await vscode.workspace.fs.createDirectory(uri(absolutePath));
    },
  };
}

export async function writeTemp(workspaceFolder: vscode.Uri, absolutePath: string, bytes: Uint8Array): Promise<void> {
  if (!isBridgeTempPath(absolutePath)) throw new Error(`Rejected temporary path: ${absolutePath}`);
  await vscode.workspace.fs.writeFile(remoteUri(workspaceFolder, absolutePath), bytes);
}

export async function readTemp(workspaceFolder: vscode.Uri, absolutePath: string): Promise<Uint8Array | null> {
  if (!isBridgeTempPath(absolutePath)) throw new Error(`Rejected temporary path: ${absolutePath}`);
  try {
    return await vscode.workspace.fs.readFile(remoteUri(workspaceFolder, absolutePath));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function deleteTemp(workspaceFolder: vscode.Uri, absolutePath: string): Promise<void> {
  if (!isBridgeTempPath(absolutePath)) throw new Error(`Rejected temporary path: ${absolutePath}`);
  try {
    await vscode.workspace.fs.delete(remoteUri(workspaceFolder, absolutePath));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

let taskSerial = 0;

export function runRemoteProcess(command: string, args: string[]): Promise<number> {
  const name = `cursor-skill-bridge-${Date.now()}-${taskSerial++}`;
  const task = new vscode.Task(
    { type: 'cursorSkillBridge', id: name },
    vscode.TaskScope.Workspace,
    name,
    'Cursor Skill Bridge',
    new vscode.ProcessExecution(command, args),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Never,
    panel: vscode.TaskPanelKind.Dedicated,
    close: true,
    echo: false,
    showReuseMessage: false,
    focus: false,
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Container command did not finish: ${command}`));
    }, 60_000);
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.name !== name) return;
      clearTimeout(timer);
      subscription.dispose();
      resolve(event.exitCode ?? 1);
    });
    vscode.tasks.executeTask(task).then(undefined, (error: unknown) => {
      clearTimeout(timer);
      subscription.dispose();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function applyExecutableBits(
  workspaceFolder: vscode.Uri,
  containerHome: string,
  paths: string[],
  log: (message: string) => void,
): Promise<number> {
  if (paths.length === 0) return 0;
  const payload = buildChmodPayload(paths, containerHome, randomBytes(8).toString('hex'));
  for (const rejected of payload.rejected) log(`chmod skipped: ${rejected}`);
  if (payload.paths.length === 0) return 0;
  const encode = (value: string) => new TextEncoder().encode(value);
  await writeTemp(workspaceFolder, payload.listPath, encode(payload.listText));
  await writeTemp(workspaceFolder, payload.scriptPath, encode(payload.script));
  try {
    const code = await runRemoteProcess('/bin/sh', [payload.scriptPath, containerHome]);
    const statusBytes = await readTemp(workspaceFolder, payload.statusPath);
    const status = statusBytes ? Buffer.from(statusBytes).toString('utf8').trim() : '';
    if (code !== 0 || status !== 'ok') {
      throw new Error(`chmod finished with code ${code}, status "${status || 'none'}"`);
    }
    return payload.paths.length;
  } finally {
    await deleteTemp(workspaceFolder, payload.listPath).catch(() => undefined);
    await deleteTemp(workspaceFolder, payload.scriptPath).catch(() => undefined);
    await deleteTemp(workspaceFolder, payload.statusPath).catch(() => undefined);
    await deleteTemp(workspaceFolder, `${payload.statusPath}.err`).catch(() => undefined);
  }
}
