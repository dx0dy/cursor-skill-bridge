# Cursor Skill Bridge limitations

Checked in this Dev Container before implementation, Cursor 3.20.21, user `vscode`, HOME `/home/vscode`.

## What was verified

Writing bytes creates a file with mode `644`. A script in that mode does not run: `Permission denied`, exit code 126. After `chmod a+x` the mode becomes `755`, and the same script runs.

The container's `~/.cursor` lives on the container overlay filesystem. The workspace directory is mounted separately (`virtiofs`). The host home directory is not mounted into the container, so an extension running inside the container cannot see the host `~/.cursor`.

`~/.cursor/plugins/local` is writable by the `vscode` user.

The generated `chmod` script sets `a+x` only for paths inside the given HOME and leaves a file outside that HOME without the executable bit. A test covers this.

## `vscode.workspace.fs` cannot preserve the executable bit

In the VS Code 1.85+ API that this extension's types use, `vscode.workspace.fs`:

- `writeFile(uri, content)` accepts bytes only;
- `FileStat.permissions` is only `Readonly`, or it is absent;
- `copy` between different roots also drops the executable bit. This is discussed in [microsoft/vscode#84175](https://github.com/microsoft/vscode/issues/84175) and in devcontainers/cli#83.

File contents are therefore copied through `vscode.workspace.fs`, and `chmod a+x` is applied separately.

## Where the extension runs

One extension host is not local and remote at the same time. To read the host, `package.json` sets `"extensionKind": ["ui"]`. Node `fs` in that process is the host disk, and the read module has no write operations.

Writes into the container use a `vscode-remote` URI with the authority of the open workspace folder and an absolute container path. VS Code then sends the call to the Dev Container filesystem even though the extension is running locally. The local Extension Host cannot be called from this session: the agent runs inside the container. If the container provider refuses to write a path outside the workspace, the sync command records the error in the `Cursor Skill Bridge` output channel.

## How `chmod` runs without installing tools in the container

The extension writes a path list and a script to `/tmp/cursor-skill-bridge-<nonce>.*` through `vscode.workspace.fs`, then runs `/bin/sh` as a VS Code task. A workspace task runs on the workspace machine, which is the container. `/bin/sh` and `chmod` are in the base image.

The script changes only paths inside the container HOME. If the task starts on the host by mistake, the script with that nonce is not on the host, the command fails, and host files stay unchanged. Success is accepted only when the remote status file contains `ok`.

`~` in a destination expands to the container HOME. The extension learns that HOME by having a task write `$HOME` to `/tmp` and reading the file back through the remote filesystem. If that file is missing in the container, it uses `/home/vscode` or `/root` when those directories exist.

## What is copied

- Skills: immediate subdirectories of `~/.cursor/skills` on the host → `~/.cursor/skills/<name>` in the container.
- Plugins: directories `~/.cursor/plugins/local/*` that contain `.cursor-plugin/plugin.json` or a root `plugin.json` → `~/.cursor/plugins/local/<name>`.
- The marketplace cache `~/.cursor/plugins/cache` is not scanned.
- An extra folder uses the path from settings or from the view. A folder with a plugin manifest is suggested as `~/.cursor/plugins/local/<name>`. A skill is suggested as `~/.cursor/skills/<name>`.

Sync is one-way. Extra files in the container are not deleted. The `.git` directory is skipped. A symlink to a file inside the source folder is copied as a regular file. A symlink that points outside, and a symlink to a directory, are skipped: `vscode.workspace.fs` does not create symlinks, and following a link outside the source would read other host files.

A later run does not rewrite a file when the bytes match. Executable files request `chmod a+x` again: the API does not report the current executable bit in the container.

## Watching the host

`vscode.workspace.createFileSystemWatcher` watches the workspace only, not `~/.cursor`. The extension uses `fs.watch` with `recursive: true` on the selected roots. That is the normal Node mechanism, and on macOS it does not walk every file on its own.

When the selection has more than 5000 files, or `fs.watch` is unavailable, watching is turned off. Sync on Dev Container connect and the `Cursor Skill Bridge: Sync Cursor Skills/Plugins` command remain.

## Settings

The folder list is the single key `cursorSkillBridge.folders`. A User Settings value applies to every workspace. A `.vscode/settings.json` value applies to this workspace and overrides the user value for the same path. The view checkbox writes to the workspace. `Cursor Skill Bridge: Sync Cursor Item in User Settings` moves the folder into user settings.

The extension does not modify `devcontainer.json`. An empty list does not create a settings file by itself.
