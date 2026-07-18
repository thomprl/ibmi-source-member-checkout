import * as vscode from "vscode";
import {
  CheckedOutMember,
  TreeItemType,
  formatMemberPath,
} from "./types";
import { CheckoutService } from "./checkoutService";
import { getSystemName } from "./codeForIBMi";

export class CheckoutTreeProvider
  implements vscode.TreeDataProvider<TreeItemType>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TreeItemType | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private searchTerm = "";

  constructor(private readonly service: CheckoutService) {
    service.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setSearchTerm(term: string): void {
    this.searchTerm = term.trim().toLowerCase();
    this.refresh();
  }

  getSearchTerm(): string {
    return this.searchTerm;
  }

  getFilteredCount(): number {
    if (!this.searchTerm) {
      return 0;
    }
    const system = getSystemName();
    if (!system) {
      return 0;
    }
    return this.service
      .getEntriesForSystem(system)
      .filter((e) => this.matchesSearch(e)).length;
  }

  private matchesSearch(entry: CheckedOutMember): boolean {
    if (!this.searchTerm) {
      return true;
    }
    return entry.memberName.toLowerCase().includes(this.searchTerm);
  }

  getTreeItem(element: TreeItemType): vscode.TreeItem {
    switch (element.kind) {
      case "sourceFile":
        return this.buildSourceFileItem(element.library, element.sourceFile);
      case "member":
        return this.buildMemberItem(element.entry);
    }
  }

  getParent(element: TreeItemType): TreeItemType | undefined {
    if (element.kind !== "member") {
      return undefined;
    }

    const system = getSystemName();
    if (!system) {
      return undefined;
    }

    return {
      kind: "sourceFile",
      system,
      library: element.entry.library,
      sourceFile: element.entry.sourceFile,
    };
  }

  getChildren(element?: TreeItemType): TreeItemType[] {
    if (!element) {
      return this.getRootChildren();
    }

    switch (element.kind) {
      case "sourceFile":
        return this.getMembersForSourceFile(
          element.system,
          element.library,
          element.sourceFile
        );
      case "member":
        return [];
    }
  }

  private getRootChildren(): TreeItemType[] {
    const system = getSystemName();
    if (!system) {
      return [];
    }

    const entries = this.service
      .getEntriesForSystem(system)
      .filter((e) => this.matchesSearch(e));
    if (entries.length === 0) {
      return [];
    }

    const seen = new Set<string>();
    const result: Extract<TreeItemType, { kind: "sourceFile" }>[] = [];

    for (const entry of entries) {
      const key = `${entry.library}/${entry.sourceFile}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          kind: "sourceFile",
          system,
          library: entry.library,
          sourceFile: entry.sourceFile,
        });
      }
    }

    result.sort(
      (a, b) =>
        a.library.localeCompare(b.library) ||
        a.sourceFile.localeCompare(b.sourceFile)
    );

    return result;
  }

  private getMembersForSourceFile(
    system: string,
    library: string,
    sourceFile: string
  ): TreeItemType[] {
    return this.service
      .getEntriesForSystem(system)
      .filter(
        (e) =>
          e.library.toUpperCase() === library.toUpperCase() &&
          e.sourceFile.toUpperCase() === sourceFile.toUpperCase()
      )
      .filter((e) => this.matchesSearch(e))
      .sort((a, b) => a.memberName.localeCompare(b.memberName))
      .map((entry) => ({ kind: "member" as const, entry }));
  }

  private buildSourceFileItem(
    library: string,
    sourceFile: string
  ): vscode.TreeItem {
    const collapsibleState = this.searchTerm
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(
      `${library}/${sourceFile}`,
      collapsibleState
    );
    item.contextValue = "sourceFileGroup";
    item.iconPath = new vscode.ThemeIcon("folder-library");
    return item;
  }

  private buildMemberItem(entry: CheckedOutMember): vscode.TreeItem {
    const label = `${entry.memberName}.${entry.extension.toUpperCase()}`;
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None
    );

    item.description = this.getStatusDescription(entry);
    item.tooltip = this.getTooltip(entry);
    item.iconPath = this.getStatusIcon(entry);
    item.contextValue = `checkout-${entry.status}`;

    item.command = {
      command: "ibmi-checkout.openLocalFile",
      title: "Open Local File",
      arguments: [{ kind: "member", entry }],
    };

    return item;
  }

  private getStatusDescription(entry: CheckedOutMember): string {
    const checkedOutDate = new Date(entry.checkedOutAt).toLocaleDateString();
    const checkedDate = entry.lastCheckedAt
      ? new Date(entry.lastCheckedAt).toLocaleDateString()
      : checkedOutDate;

    switch (entry.status) {
      case "checked-out":
        return `checked out ${checkedOutDate}`;
      case "merged":
        return `merged ${checkedDate}`;
      case "modified":
        return `local changes pending (checked ${checkedDate})`;
      case "conflict":
        return `conflict detected ${checkedDate}`;
      case "in-sync":
        return `in sync ${checkedDate}`;
    }
  }

  private getTooltip(entry: CheckedOutMember): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${formatMemberPath(entry)}**\n\n`);
    md.appendMarkdown(`- **System:** ${entry.system}\n`);
    md.appendMarkdown(`- **Status:** ${entry.status}\n`);
    md.appendMarkdown(
      `- **Checked out:** ${new Date(entry.checkedOutAt).toLocaleString()}\n`
    );
    if (entry.lastCheckedAt) {
      md.appendMarkdown(
        `- **Last checked:** ${new Date(entry.lastCheckedAt).toLocaleString()}\n`
      );
    }
    md.appendMarkdown(`- **Local:** ${entry.localPath}\n`);
    return md;
  }

  private getStatusIcon(entry: CheckedOutMember): vscode.ThemeIcon {
    switch (entry.status) {
      case "checked-out":
        return new vscode.ThemeIcon(
          "edit",
          new vscode.ThemeColor("charts.yellow")
        );
      case "merged":
        return new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green")
        );
      case "modified":
        return new vscode.ThemeIcon(
          "pencil",
          new vscode.ThemeColor("charts.orange")
        );
      case "conflict":
        return new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("charts.red")
        );
      case "in-sync":
        return new vscode.ThemeIcon(
          "check-all",
          new vscode.ThemeColor("charts.green")
        );
    }
  }
}
