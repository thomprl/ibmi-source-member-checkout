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
      case "library":
        return this.buildLibraryItem(element.system, element.library);
      case "sourceFile":
        return this.buildSourceFileItem(
          element.system,
          element.library,
          element.sourceFile
        );
      case "member":
        return this.buildMemberItem(element.entry);
    }
  }

  getParent(element: TreeItemType): TreeItemType | undefined {
    const system = getSystemName();
    if (!system) {
      return undefined;
    }

    switch (element.kind) {
      case "library":
        return undefined;
      case "sourceFile":
        return { kind: "library", system, library: element.library };
      case "member":
        return {
          kind: "sourceFile",
          system,
          library: element.entry.library,
          sourceFile: element.entry.sourceFile,
        };
    }
  }

  getChildren(element?: TreeItemType): TreeItemType[] {
    if (!element) {
      return this.getLibraries();
    }

    switch (element.kind) {
      case "library":
        return this.getSourceFilesForLibrary(element.system, element.library);
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

  private getVisibleEntries(system: string): CheckedOutMember[] {
    return this.service
      .getEntriesForSystem(system)
      .filter((e) => this.matchesSearch(e));
  }

  private getLibraries(): TreeItemType[] {
    const system = getSystemName();
    if (!system) {
      return [];
    }

    const libraries = new Set(
      this.getVisibleEntries(system).map((e) => e.library)
    );

    return [...libraries]
      .sort((a, b) => a.localeCompare(b))
      .map((library) => ({ kind: "library" as const, system, library }));
  }

  private getSourceFilesForLibrary(
    system: string,
    library: string
  ): TreeItemType[] {
    const sourceFiles = new Set(
      this.getVisibleEntries(system)
        .filter((e) => e.library.toUpperCase() === library.toUpperCase())
        .map((e) => e.sourceFile)
    );

    return [...sourceFiles]
      .sort((a, b) => a.localeCompare(b))
      .map((sourceFile) => ({
        kind: "sourceFile" as const,
        system,
        library,
        sourceFile,
      }));
  }

  private getMembersForSourceFile(
    system: string,
    library: string,
    sourceFile: string
  ): TreeItemType[] {
    return this.getVisibleEntries(system)
      .filter(
        (e) =>
          e.library.toUpperCase() === library.toUpperCase() &&
          e.sourceFile.toUpperCase() === sourceFile.toUpperCase()
      )
      .sort((a, b) => a.memberName.localeCompare(b.memberName))
      .map((entry) => ({ kind: "member" as const, entry }));
  }

  private groupCollapsibleState(): vscode.TreeItemCollapsibleState {
    return this.searchTerm
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  private buildLibraryItem(system: string, library: string): vscode.TreeItem {
    const item = new vscode.TreeItem(library, this.groupCollapsibleState());
    // Stable ids let VS Code remember each node's expand/collapse state
    // across refreshes; source file labels alone are no longer unique.
    item.id = `lib:${system}:${library}`.toUpperCase();
    item.contextValue = "libraryGroup";
    item.iconPath = new vscode.ThemeIcon("library");
    return item;
  }

  private buildSourceFileItem(
    system: string,
    library: string,
    sourceFile: string
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(sourceFile, this.groupCollapsibleState());
    item.id = `spf:${system}:${library}:${sourceFile}`.toUpperCase();
    item.tooltip = `${library}/${sourceFile}`;
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
    item.id = `mbr:${entry.id}`;

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
      case "remote-missing":
        return `remote member does not exist (checked ${checkedDate})`;
      case "local-only":
        return "new — not on the IBM i yet";
      case "local-missing":
        return `local file missing (checked ${checkedDate})`;
    }
  }

  private getTooltip(entry: CheckedOutMember): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${formatMemberPath(entry)}**\n\n`);
    if (entry.memberText) {
      md.appendMarkdown(`- **Text:** `);
      md.appendText(entry.memberText);
      md.appendMarkdown(`\n`);
    }
    md.appendMarkdown(`- **System:** ${entry.system}\n`);
    md.appendMarkdown(`- **Status:** ${entry.status}\n`);
    if (entry.status === "remote-missing") {
      md.appendMarkdown(
        `- **Warning:** the member no longer exists on the IBM i. Your local copy is the only one left.\n`
      );
    }
    if (entry.status === "local-missing") {
      md.appendMarkdown(
        `- **Warning:** the local file is missing. It may have been renamed, moved or deleted. Open it for options to restore or remove it.\n`
      );
    }
    if (entry.status === "local-only") {
      md.appendMarkdown(
        `- **New:** this file was created locally. Use **Create on IBM i** to add the member.\n`
      );
    }
    md.appendMarkdown(
      `- **${entry.status === "local-only" ? "Added" : "Checked out"}:** ${new Date(entry.checkedOutAt).toLocaleString()}\n`
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
      case "remote-missing":
        return new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("errorForeground")
        );
      case "local-only":
        return new vscode.ThemeIcon(
          "diff-added",
          new vscode.ThemeColor("charts.blue")
        );
      case "local-missing":
        return new vscode.ThemeIcon(
          "circle-slash",
          new vscode.ThemeColor("errorForeground")
        );
    }
  }
}
