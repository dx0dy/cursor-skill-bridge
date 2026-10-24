import * as vscode from 'vscode';
import type { ResolvedItem } from './types';

export class GroupNode {
  constructor(
    readonly label: string,
    readonly children: ItemNode[],
  ) {}
}

export class ItemNode {
  constructor(readonly item: ResolvedItem) {}
}

export class BridgeTree implements vscode.TreeDataProvider<GroupNode | ItemNode> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private items: ResolvedItem[] = [];

  show(items: ResolvedItem[]): void {
    this.items = items;
    this.changes.fire();
  }

  getTreeItem(element: GroupNode | ItemNode): vscode.TreeItem {
    if (element instanceof GroupNode) {
      return new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
    }
    const treeItem = new vscode.TreeItem(element.item.name, vscode.TreeItemCollapsibleState.None);
    treeItem.checkboxState = element.item.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    treeItem.description =
      element.item.scope === 'user' ? 'user' : element.item.scope === 'workspace' ? 'workspace' : 'off';
    treeItem.tooltip = `${element.item.source} → ${element.item.target}`;
    treeItem.contextValue = element.item.origin === 'manual' ? 'manual' : 'item';
    const icon = element.item.kind === 'skill' ? 'book' : element.item.kind === 'plugin' ? 'extensions' : 'folder';
    treeItem.iconPath = new vscode.ThemeIcon(icon);
    return treeItem;
  }

  getChildren(element?: GroupNode | ItemNode): Array<GroupNode | ItemNode> {
    if (element instanceof GroupNode) return element.children;
    if (element instanceof ItemNode) return [];
    const groups: Array<[string, ResolvedItem[]]> = [
      ['Skills', this.items.filter((item) => item.kind === 'skill')],
      ['Plugins', this.items.filter((item) => item.kind === 'plugin')],
      ['Folders', this.items.filter((item) => item.kind === 'folder')],
    ];
    return groups
      .filter(([, items]) => items.length > 0)
      .map(([label, items]) => new GroupNode(label, items.map((item) => new ItemNode(item))));
  }
}
