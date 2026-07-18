import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  CheckedOutMember,
  CheckoutIndex,
  CheckoutStatus,
  RefreshTally,
  buildCheckoutId,
  buildLocalFileName,
  formatMemberPath,
  sanitizeSystemName,
} from "./types";
import {
  downloadMemberContent,
  uploadMemberContent,
  getSystemName,
} from "./codeForIBMi";

export class CheckoutService {
  private index: CheckoutIndex = { version: 1, entries: [] };
  private storageUri: vscode.Uri;
  private checkoutsUri: vscode.Uri;
  private indexUri: vscode.Uri;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    this.storageUri = context.globalStorageUri;
    this.checkoutsUri = vscode.Uri.joinPath(this.storageUri, "checkouts");
    this.indexUri = vscode.Uri.joinPath(this.storageUri, "checkout-index.json");
  }

  async initialize(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.checkoutsUri);
    } catch {
      // already exists
    }
    await this.loadIndex();
  }

  getEntriesForSystem(system: string): CheckedOutMember[] {
    return this.index.entries.filter(
      (e) => e.system.toUpperCase() === system.toUpperCase()
    );
  }

  findEntry(
    system: string,
    library: string,
    sourceFile: string,
    memberName: string
  ): CheckedOutMember | undefined {
    const id = buildCheckoutId(system, library, sourceFile, memberName);
    return this.index.entries.find((e) => e.id === id);
  }

  async checkoutMember(
    library: string,
    sourceFile: string,
    memberName: string,
    memberExtension: string,
    options?: { redownloadBehavior?: "ask" | "skip" | "force"; suppressAutoOpen?: boolean }
  ): Promise<CheckedOutMember> {
    const { redownloadBehavior = "ask", suppressAutoOpen = false } = options ?? {};

    const system = getSystemName();
    if (!system) {
      throw new Error("Not connected to IBM i");
    }

    const existing = this.findEntry(system, library, sourceFile, memberName);
    if (existing) {
      if (redownloadBehavior === "skip") {
        return existing;
      }

      if (redownloadBehavior === "ask") {
        const config = vscode.workspace.getConfiguration("ibmi-checkout");
        const warn = config.get<boolean>("warnOnRedownload", true);

        if (warn) {
          const choice = await vscode.window.showWarningMessage(
            `${formatMemberPath(existing)} is already checked out since ${new Date(existing.checkedOutAt).toLocaleDateString()}. What would you like to do?`,
            "Open Existing",
            "Re-download",
            "Cancel"
          );

          if (choice === "Open Existing") {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(existing.localPath)
            );
            await vscode.window.showTextDocument(doc);
            return existing;
          }

          if (choice !== "Re-download") {
            throw new Error("Checkout cancelled");
          }
        }
      }
      // redownloadBehavior === "force" falls through to re-download below
    }

    const content = await downloadMemberContent(
      library,
      sourceFile,
      memberName
    );

    const entry: CheckedOutMember = {
      id: buildCheckoutId(system, library, sourceFile, memberName),
      system,
      library: library.toUpperCase(),
      sourceFile: sourceFile.toUpperCase(),
      memberName: memberName.toUpperCase(),
      extension: memberExtension.toLowerCase(),
      localPath: "",
      checkedOutAt: new Date().toISOString(),
      remoteHashAtCheckout: "",
      status: "checked-out",
    };

    const localPath = await this.getLocalPath(entry);
    entry.localPath = localPath;

    const hash = this.hashContent(content, vscode.Uri.file(localPath));
    entry.remoteHashAtCheckout = hash;

    this.log.appendLine(
      `[checkout] ${library}/${sourceFile}/${memberName}  remoteHashAtCheckout=${hash.substring(0, 12)}`
    );

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(localPath),
      Buffer.from(content, "utf-8")
    );

    if (existing) {
      const idx = this.index.entries.findIndex((e) => e.id === entry.id);
      this.index.entries[idx] = entry;
    } else {
      this.index.entries.push(entry);
    }

    await this.saveIndex();
    this._onDidChange.fire();

    if (!suppressAutoOpen) {
      const config = vscode.workspace.getConfiguration("ibmi-checkout");
      if (config.get<boolean>("autoOpenOnCheckout", true)) {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(localPath)
        );
        await vscode.window.showTextDocument(doc);
      }

      vscode.window.showInformationMessage(
        `Checked out ${formatMemberPath(entry)} from ${system}`
      );
    }

    return entry;
  }

  async refreshRemoteStatus(
    entry: CheckedOutMember
  ): Promise<"in-sync" | "modified" | "conflict"> {
    const localUri = vscode.Uri.file(entry.localPath);

    const remoteContent = await downloadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName
    );
    const remoteHash = this.hashContent(remoteContent, localUri);

    const localContent = Buffer.from(
      await vscode.workspace.fs.readFile(localUri)
    ).toString("utf-8");
    const localHash = this.hashContent(localContent, localUri);

    let status: CheckoutStatus;
    if (localHash === remoteHash) {
      status = "in-sync";
    } else if (remoteHash === entry.remoteHashAtCheckout) {
      status = "modified";
    } else {
      status = "conflict";
    }

    this.log.appendLine(
      `[refresh] ${entry.library}/${entry.sourceFile}/${entry.memberName}` +
      `  local=${localHash.substring(0, 12)}` +
      `  remote=${remoteHash.substring(0, 12)}` +
      `  baseline=${entry.remoteHashAtCheckout?.substring(0, 12)}` +
      `  → ${status}`
    );

    entry.status = status;
    entry.lastCheckedAt = new Date().toISOString();
    await this.saveIndex();
    this._onDidChange.fire();

    return status;
  }

  async recheckout(entry: CheckedOutMember): Promise<void> {
    const content = await downloadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName
    );
    const hash = this.hashContent(content, vscode.Uri.file(entry.localPath));

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(entry.localPath),
      Buffer.from(content, "utf-8")
    );

    entry.remoteHashAtCheckout = hash;
    entry.checkedOutAt = new Date().toISOString();
    entry.lastCheckedAt = entry.checkedOutAt;
    entry.status = "in-sync";
    await this.saveIndex();
    this._onDidChange.fire();
  }

  async uploadToRemote(entry: CheckedOutMember): Promise<boolean> {
    const localContent = Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.file(entry.localPath))
    ).toString("utf-8");

    const success = await uploadMemberContent(
      entry.library,
      entry.sourceFile,
      entry.memberName,
      localContent
    );

    if (success) {
      const newHash = this.hashContent(localContent, vscode.Uri.file(entry.localPath));
      entry.remoteHashAtCheckout = newHash;
      entry.lastCheckedAt = new Date().toISOString();
      entry.status = "merged";
      await this.saveIndex();
      this._onDidChange.fire();
    }

    return success;
  }

  async refreshSourceFileRemoteStatus(
    system: string,
    library: string,
    sourceFile: string
  ): Promise<RefreshTally> {
    const entries = this.getEntriesForSystem(system).filter(
      (e) =>
        e.library.toUpperCase() === library.toUpperCase() &&
        e.sourceFile.toUpperCase() === sourceFile.toUpperCase()
    );
    return this.refreshEntries(entries);
  }

  async refreshAllRemoteStatus(): Promise<RefreshTally> {
    const system = getSystemName();
    if (!system) {
      return { inSync: 0, modified: 0, conflict: 0, errors: 0 };
    }

    return this.refreshEntries(this.getEntriesForSystem(system));
  }

  async refreshEntries(
    entries: CheckedOutMember[]
  ): Promise<RefreshTally> {
    const tally: RefreshTally = { inSync: 0, modified: 0, conflict: 0, errors: 0 };

    for (const entry of entries) {
      try {
        const result = await this.refreshRemoteStatus(entry);
        if (result === "in-sync") {
          tally.inSync++;
        } else if (result === "modified") {
          tally.modified++;
        } else {
          tally.conflict++;
        }
      } catch {
        tally.errors++;
      }
    }

    return tally;
  }

  async discardCheckout(entry: CheckedOutMember): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Delete ${formatMemberPath(entry)} and remove from checkouts?`,
      { detail: "Make sure you've already merged any changes back to the IBM i.", modal: true },
      "Delete"
    );

    if (choice !== "Delete") {
      return;
    }

    await this.discardEntries([entry]);
  }

  async discardEntries(entries: CheckedOutMember[]): Promise<void> {
    for (const entry of entries) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(entry.localPath));
      } catch {
        // file may already be gone
      }
    }

    const ids = new Set(entries.map((e) => e.id));
    this.index.entries = this.index.entries.filter((e) => !ids.has(e.id));
    await this.saveIndex();
    this._onDidChange.fire();
  }

  hashContent(content: string, resource?: vscode.Uri): string {
    const filesConfig = vscode.workspace.getConfiguration("files", resource);
    const trimTrailingWhitespace = filesConfig.get<boolean>("trimTrailingWhitespace", false);

    let normalized = content.replace(/\r\n/g, "\n");
    if (trimTrailingWhitespace) {
      normalized = normalized.replace(/[ \t]+$/gm, "");
    }
    // Only a trailing run of blank lines is ignored (anchored to the very end of
    // the string, no /m flag) — leading/embedded blank lines are left untouched.
    normalized = normalized.replace(/\n+$/, "");
    return crypto.createHash("sha256").update(normalized, "utf-8").digest("hex");
  }

  private async getLocalPath(entry: CheckedOutMember): Promise<string> {
    const config = vscode.workspace.getConfiguration("ibmi-checkout");
    const customFolder = config.get<string>("localFolder", "");
    const systemFolder = sanitizeSystemName(entry.system);
    const fileName = buildLocalFileName(entry);

    let baseDir: vscode.Uri;
    if (customFolder) {
      baseDir = vscode.Uri.joinPath(
        vscode.Uri.file(customFolder),
        systemFolder, entry.library, entry.sourceFile
      );
    } else {
      baseDir = vscode.Uri.joinPath(
        this.checkoutsUri,
        systemFolder, entry.library, entry.sourceFile
      );
    }

    try {
      await vscode.workspace.fs.createDirectory(baseDir);
    } catch {
      // already exists
    }

    return vscode.Uri.joinPath(baseDir, fileName).fsPath;
  }

  private async loadIndex(): Promise<void> {
    try {
      const data = await vscode.workspace.fs.readFile(this.indexUri);
      this.index = JSON.parse(Buffer.from(data).toString("utf-8"));
    } catch {
      this.index = { version: 1, entries: [] };
    }
  }

  private async saveIndex(): Promise<void> {
    const data = JSON.stringify(this.index, null, 2);
    await vscode.workspace.fs.writeFile(
      this.indexUri,
      Buffer.from(data, "utf-8")
    );
  }
}
