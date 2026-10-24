# Original brief: a Cursor extension that syncs personal plugins into a Dev Container

This is the original development brief. Current install and usage instructions are in the README.

Build a local VS Code/Cursor extension that syncs selected host directories into a Dev Container.

The first version covers two things:

- automatic copy of Cursor skills from the host;
- automatic copy of Cursor plugins from the host.

## Requirements

1. **Local install:** through a `.vsix`, without publishing to a Marketplace.
3. **Configuration:** the extension shows, on a simple panel, the skills and plugins available for the current project. The user chooses what to copy into the Dev Container. Settings are stored for the project. A global import for every project is also possible. Follow the usual VS Code extension pattern for settings.
   It must be possible to add extra folders by hand.
4. **Automatic sync:** when a Dev Container connects.
   - Watch the host and sync when source files change, within a reasonable limit so a large tree is not a problem. If watching is expensive and there is no simple built-in method, sync only when the Dev Container is created.
5. **Manual sync:** the command `Cursor Skill Bridge: Sync Cursor Skills/Plugins` from the Command Palette.
6. **Files:** recursive incremental sync, subdirectories, preserved executable permissions (`chmod +x`), and `.git` excluded.
7. **Safety:** one-way sync, with no deletion of unrelated files in the container. The host is read-only.
8. **Diagnostics:** log errors to an output channel.

## Example 1 (a skill discovered on the host)

Source on macOS:
`~/.cursor/skills/sequential-best-of-n`

Destination in the container:
`~/.cursor/skills/sequential-best-of-n`

## Example 2 (a chosen folder)

Source on macOS:

`/Users/example/projects/example-plugin`

Destination in the container:

`~/.cursor/plugins/local/example-plugin`

`~` is resolved against the container user's HOME, not the host HOME.

## Constraints

- Do not modify `devcontainer.json` or any project files.
- Do not use Docker mounts, git clone, an SSH server, the GitHub API, or tokens.
- Prefer the standard VS Code API (`vscode.workspace.fs`).
- Do not install extra software in the container unless it is necessary.
- Work with any Dev Container, regardless of the repository.

## Result

A finished extension with source, instructions for building a `.vsix`, and a configuration example.

Verify it in Cursor 3.20.21 on a Dev Container whose user is `vscode`. After sync, the local Cursor plugin `.cursor-plugin/plugin.json` must be discoverable, and the `/time` skill must successfully run `skills/time/scripts/now.sh`.

Before implementation, verify that a local Extension Host can write to the Dev Container filesystem, preserve executable permissions, and that Cursor can discover new plugins. If the standard API has limits, document them and propose the smallest solution that still meets the other requirements.
