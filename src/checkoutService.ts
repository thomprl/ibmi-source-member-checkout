import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  CheckedOutMember,
  CheckoutIndex,
  CheckoutStatus,
  RefreshTally,
  RelocateResult,
  buildCheckoutId,
  buildLocalFileName,
  formatMemberPath,
  isSamePath,
  sanitizeSystemName,
} from "./types";
import {
  downloadMemberContent,
  uploadMemberContent,
  getSystemName,
  memberExists,
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
  ): Promise<"in-sync" | "modified" | "conflict" | "remote-missing"> {
    const localUri = vscode.Uri.file(entry.localPath);
    const memberPath = `${entry.library}/${entry.sourceFile}/${entry.memberName}`;

    let remoteContent: string;
    try {
      remoteContent = await downloadMemberContent(
        entry.library,
        entry.sourceFile,
        entry.memberName
      );
    } catch (err: any) {
      // A failed download may just be a transient error; only flag the member
      // as missing when the IBM i confirms it no longer exists.
      let exists = true;
      try {
        exists = await memberExists(entry.library, entry.sourceFile, entry.memberName);
      } catch {
        // can't tell — treat as a normal error below
      }
      if (!exists) {
        this.log.appendLine(`[refresh] ${memberPath}  → remote-missing`);
        await this.setStatus(entry, "remote-missing");
        return "remote-missing";
      }
      throw err;
    }

    const remoteHash = this.hashContent(remoteContent, localUri);

    const localContent = Buffer.from(
      await vscode.workspace.fs.readFile(localUri)
    ).toString("utf-8");
    const localHash = this.hashContent(localContent, localUri);

    // Baselines stored before the hash normalization changed were computed with
    // the legacy algorithm; accept those too and upgrade the stored baseline.
    const remoteUnchanged =
      remoteHash === entry.remoteHashAtCheckout ||
      this.legacyHashContent(remoteContent, localUri) === entry.remoteHashAtCheckout;
    if (remoteUnchanged) {
      entry.remoteHashAtCheckout = remoteHash;
    }

    let status: "in-sync" | "modified" | "conflict";
    if (localHash === remoteHash) {
      status = "in-sync";
    } else if (remoteUnchanged) {
      status = "modified";
    } else {
      status = "conflict";
    }

    this.log.appendLine(
      `[refresh] ${memberPath}` +
      `  local=${localHash.substring(0, 12)}` +
      `  remote=${remoteHash.substring(0, 12)}` +
      `  baseline=${entry.remoteHashAtCheckout?.substring(0, 12)}` +
      `  → ${status}`
    );

    await this.setStatus(entry, status);
    return status;
  }

  private async setStatus(entry: CheckedOutMember, status: CheckoutStatus): Promise<void> {
    entry.status = status;
    entry.lastCheckedAt = new Date().toISOString();
    await this.saveIndex();
    this._onDidChange.fire();
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

  async refreshLibraryRemoteStatus(
    system: string,
    library: string
  ): Promise<RefreshTally> {
    const entries = this.getEntriesForSystem(system).filter(
      (e) => e.library.toUpperCase() === library.toUpperCase()
    );
    return this.refreshEntries(entries);
  }

  async refreshAllRemoteStatus(): Promise<RefreshTally> {
    const system = getSystemName();
    if (!system) {
      return { inSync: 0, modified: 0, conflict: 0, missing: 0, errors: 0 };
    }

    return this.refreshEntries(this.getEntriesForSystem(system));
  }

  async refreshEntries(
    entries: CheckedOutMember[]
  ): Promise<RefreshTally> {
    const tally: RefreshTally = { inSync: 0, modified: 0, conflict: 0, missing: 0, errors: 0 };

    for (const entry of entries) {
      try {
        const result = await this.refreshRemoteStatus(entry);
        if (result === "in-sync") {
          tally.inSync++;
        } else if (result === "modified") {
          tally.modified++;
        } else if (result === "remote-missing") {
          tally.missing++;
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

    let normalized = content
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");
    if (trimTrailingWhitespace) {
      normalized = normalized.replace(/[ \t]+$/gm, "");
    }
    // Ignore everything after the last non-blank character: trailing blank
    // lines (including lines holding only blank-padding) never affect the hash.
    // Anchored to the very end (no /m flag), so embedded blank lines still count.
    normalized = normalized.replace(/\s+$/, "");
    return crypto.createHash("sha256").update(normalized, "utf-8").digest("hex");
  }

  /** Hash algorithm used before 1.0.2 — kept only to match old stored baselines. */
  private legacyHashContent(content: string, resource?: vscode.Uri): string {
    const filesConfig = vscode.workspace.getConfiguration("files", resource);
    const trimTrailingWhitespace = filesConfig.get<boolean>("trimTrailingWhitespace", false);

    let normalized = content.replace(/\r\n/g, "\n");
    if (trimTrailingWhitespace) {
      normalized = normalized.replace(/[ \t]+$/gm, "");
    }
    normalized = normalized.replace(/\n+$/, "");
    return crypto.createHash("sha256").update(normalized, "utf-8").digest("hex");
  }

  getAllEntries(): CheckedOutMember[] {
    return [...this.index.entries];
  }

  /** Folder new checkouts are written under: the localFolder setting, or extension storage. */
  getCheckoutRoot(): vscode.Uri {
    const config = vscode.workspace.getConfiguration("ibmi-checkout");
    const customFolder = config.get<string>("localFolder", "");
    return customFolder ? vscode.Uri.file(customFolder) : this.checkoutsUri;
  }

  /** Where an entry's local file belongs under the given root folder. */
  buildLocalUri(entry: CheckedOutMember, root: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(
      root,
      sanitizeSystemName(entry.system), entry.library, entry.sourceFile,
      buildLocalFileName(entry)
    );
  }

  /**
   * Moves each entry's local file under newRoot and repoints the index at it.
   * Entries whose file can't be moved keep their old path, so they still work.
   */
  async relocateCheckouts(
    entries: CheckedOutMember[],
    newRoot: vscode.Uri,
    overwriteExisting: boolean,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<RelocateResult> {
    const result: RelocateResult = { moved: [], missing: [], skipped: [], failed: [] };

    for (const entry of entries) {
      progress?.report({ message: formatMemberPath(entry), increment: 100 / entries.length });

      const from = vscode.Uri.file(entry.localPath);
      const to = this.buildLocalUri(entry, newRoot);
      if (isSamePath(from, to)) {
        continue;
      }

      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(to, ".."));

        if (!(await uriExists(from))) {
          // Nothing to copy — just point the entry at its new home
          entry.localPath = to.fsPath;
          result.missing.push(entry);
          continue;
        }

        if (!overwriteExisting && (await uriExists(to))) {
          result.skipped.push(entry);
          continue;
        }

        await vscode.workspace.fs.copy(from, to, { overwrite: true });
        entry.localPath = to.fsPath;
        result.moved.push({ entry, from, to });
      } catch (err: any) {
        result.failed.push({ entry, error: err.message ?? String(err) });
        this.log.appendLine(`[move] Failed to move ${from.fsPath}: ${err.message ?? err}`);
        continue;
      }

      try {
        await vscode.workspace.fs.delete(from);
        await this.removeEmptyParents(from);
      } catch (err: any) {
        this.log.appendLine(
          `[move] Copied ${formatMemberPath(entry)} but could not remove the old file ${from.fsPath}: ${err.message ?? err}`
        );
      }
    }

    await this.saveIndex();
    this._onDidChange.fire();
    return result;
  }

  /** Removes the now-empty source file, library and system folders left behind by a move. */
  private async removeEmptyParents(fileUri: vscode.Uri): Promise<void> {
    let dir = vscode.Uri.joinPath(fileUri, "..");
    for (let level = 0; level < 3; level++) {
      const children = await vscode.workspace.fs.readDirectory(dir);
      if (children.length > 0) {
        return;
      }
      await vscode.workspace.fs.delete(dir);
      dir = vscode.Uri.joinPath(dir, "..");
    }
  }

  private async getLocalPath(entry: CheckedOutMember): Promise<string> {
    const fileUri = this.buildLocalUri(entry, this.getCheckoutRoot());

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, ".."));
    } catch {
      // already exists
    }

    return fileUri.fsPath;
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

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
