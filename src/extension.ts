import * as vscode from "vscode";
import { CheckoutService } from "./checkoutService";
import { CheckoutTreeProvider } from "./checkoutTreeProvider";
import { MergeHandler } from "./mergeHandler";
import { getInstance, getSystemName, listSourceFileMembers } from "./codeForIBMi";
import { TreeItemType, formatMemberPath } from "./types";

let outputChannel: vscode.OutputChannel;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("IBM i Checkout");
  context.subscriptions.push(outputChannel);

  const service = new CheckoutService(context, outputChannel);
  await service.initialize();

  const treeProvider = new CheckoutTreeProvider(service);
  const mergeHandler = new MergeHandler();

  const treeView = vscode.window.createTreeView("checkoutView", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });
  context.subscriptions.push(treeView);

  subscribeToConnectionEvents(treeProvider);

  registerCommands(context, service, treeProvider, mergeHandler, treeView);
}

function subscribeToConnectionEvents(
  treeProvider: CheckoutTreeProvider
): void {
  const instance = getInstance();
  if (!instance) {
    return;
  }

  try {
    instance.onEvent("connected", () => treeProvider.refresh());
    instance.onEvent("disconnected", () => treeProvider.refresh());
  } catch {
    // Code for i API may vary — connection events are optional
  }
}

function resolveMemberSelections(
  item: TreeItemType,
  allSelections?: TreeItemType[]
): Extract<TreeItemType, { kind: "member" }>[] {
  const selections = allSelections && allSelections.length > 1 ? allSelections : [item];
  return selections.filter(
    (s): s is Extract<TreeItemType, { kind: "member" }> => s?.kind === "member"
  );
}

function registerCommands(
  context: vscode.ExtensionContext,
  service: CheckoutService,
  treeProvider: CheckoutTreeProvider,
  mergeHandler: MergeHandler,
  treeView: vscode.TreeView<TreeItemType>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.checkoutMember",
      async (node: any, allSelections?: any[]) => {
        const selections = allSelections && allSelections.length > 1 ? allSelections : [node];
        const isBatch = selections.length > 1;

        if (!isBatch) {
          // Single item — existing behaviour
          try {
            const memberInfo = extractMemberInfo(node);
            if (!memberInfo) {
              outputChannel.appendLine(
                `[checkout] ERROR: Could not extract member info — raw node keys: ${node ? Object.keys(node).join(", ") : "null/undefined"}`
              );
              outputChannel.show();
              vscode.window.showErrorMessage(
                "Could not determine member details from selection. Check 'IBM i Checkout' output panel for details."
              );
              return;
            }
            await service.checkoutMember(
              memberInfo.library,
              memberInfo.sourceFile,
              memberInfo.memberName,
              memberInfo.extension
            );
          } catch (err: any) {
            if (err.message !== "Checkout cancelled") {
              outputChannel.appendLine(`Checkout error: ${err.message}`);
              outputChannel.appendLine(err.stack || "");
              outputChannel.show();
              vscode.window.showErrorMessage(`Checkout failed: ${err.message}`);
            }
          }
          return;
        }

        // Batch — multi-select
        const system = getSystemName();
        if (!system) {
          vscode.window.showErrorMessage("Not connected to IBM i.");
          return;
        }

        const memberInfoList = selections
          .map((s: any) => extractMemberInfo(s))
          .filter((m): m is NonNullable<ReturnType<typeof extractMemberInfo>> => m !== undefined);

        if (memberInfoList.length === 0) {
          vscode.window.showErrorMessage("Could not determine member details from the selection.");
          return;
        }

        await checkoutMembersBatch(service, system, memberInfoList, outputChannel);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.checkoutAllMembers",
      async (node: any) => {
        const sourceFileInfo = extractSourceFileInfo(node);
        if (!sourceFileInfo) {
          outputChannel.appendLine(
            `[checkout] ERROR: Could not extract source file info — raw node keys: ${node ? Object.keys(node).join(", ") : "null/undefined"}`
          );
          outputChannel.show();
          vscode.window.showErrorMessage(
            "Could not determine source file details from selection. Check 'IBM i Checkout' output panel for details."
          );
          return;
        }

        const system = getSystemName();
        if (!system) {
          vscode.window.showErrorMessage("Not connected to IBM i.");
          return;
        }

        let members;
        try {
          members = await listSourceFileMembers(sourceFileInfo.library, sourceFileInfo.sourceFile);
        } catch (err: any) {
          outputChannel.appendLine(`[checkout] Could not list members: ${err.message}`);
          vscode.window.showErrorMessage(
            `Could not list members of ${sourceFileInfo.library}/${sourceFileInfo.sourceFile}: ${err.message}`
          );
          return;
        }

        if (members.length === 0) {
          vscode.window.showInformationMessage(
            `${sourceFileInfo.library}/${sourceFileInfo.sourceFile} has no members.`
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Check out all ${members.length} member(s) from ${sourceFileInfo.library}/${sourceFileInfo.sourceFile}?`,
          {
            modal: true,
            detail:
              "Downloading a large source file can take a considerable amount of time depending on the number and size of its members and your connection speed.",
          },
          "Check Out All"
        );
        if (confirm !== "Check Out All") {
          return;
        }

        const memberInfoList = members.map((m) => ({
          library: sourceFileInfo.library,
          sourceFile: sourceFileInfo.sourceFile,
          memberName: m.name,
          extension: (m.extension || "mbr").toLowerCase(),
        }));

        await checkoutMembersBatch(service, system, memberInfoList, outputChannel);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.openLocalFile",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length > 1) {
          const confirm = await vscode.window.showWarningMessage(
            `Open ${selections.length} local files in the editor?`,
            { modal: true },
            "Open"
          );
          if (confirm !== "Open") {
            return;
          }
        }

        const options: vscode.TextDocumentShowOptions | undefined =
          selections.length > 1 ? { preview: false } : undefined;

        for (const sel of selections) {
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(sel.entry.localPath)
            );
            await vscode.window.showTextDocument(doc, options);
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Could not open ${formatMemberPath(sel.entry)}: ${err.message}`
            );
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.mergeBack",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        try {
          await mergeHandler.openMergeDiff(item.entry);
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Merge failed: ${err.message}`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.openRemoteFile",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length > 1) {
          const confirm = await vscode.window.showWarningMessage(
            `Open ${selections.length} remote files in the editor? This will contact the IBM i for each file.`,
            { modal: true },
            "Open"
          );
          if (confirm !== "Open") {
            return;
          }
        }

        const options: vscode.TextDocumentShowOptions | undefined =
          selections.length > 1 ? { preview: false } : undefined;

        for (const sel of selections) {
          const entry = sel.entry;
          const memberUri = vscode.Uri.from({
            scheme: "member",
            path: `/${entry.library}/${entry.sourceFile}/${entry.memberName}.${entry.extension.toUpperCase()}`,
          });
          try {
            const doc = await vscode.workspace.openTextDocument(memberUri);
            await vscode.window.showTextDocument(doc, options);
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Could not open remote member ${formatMemberPath(entry)}. It may no longer exist on the IBM i.`
            );
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.uploadToRemote",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length === 1) {
          const entry = selections[0].entry;
          const memberPath = formatMemberPath(entry);

          const confirm = await vscode.window.showWarningMessage(
            `Upload local copy of ${memberPath} to the IBM i? This will overwrite the remote member and source dates will not be preserved.`,
            { modal: true },
            "Upload"
          );

          if (confirm !== "Upload") {
            return;
          }

          try {
            const success = await service.uploadToRemote(entry);
            if (success) {
              vscode.window.showInformationMessage(
                `Successfully uploaded ${memberPath} to IBM i.`
              );
            } else {
              vscode.window.showErrorMessage(
                `Failed to upload ${memberPath} to IBM i.`
              );
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Upload failed: ${err.message}`
            );
          }
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Upload ${selections.length} local files to the IBM i? This will overwrite the remote members and source dates will not be preserved.`,
          { modal: true },
          "Upload All"
        );
        if (confirm !== "Upload All") {
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Uploading to IBM i...", cancellable: true },
          async (progress, token) => {
            let succeeded = 0;
            let errors = 0;
            let cancelled = false;

            for (let i = 0; i < selections.length; i++) {
              if (token.isCancellationRequested) {
                cancelled = true;
                break;
              }
              const entry = selections[i].entry;
              progress.report({ message: `${entry.memberName} (${i + 1}/${selections.length})` });
              try {
                const success = await service.uploadToRemote(entry);
                if (success) {
                  succeeded++;
                } else {
                  errors++;
                  outputChannel.appendLine(`[upload] Failed for ${formatMemberPath(entry)}`);
                }
              } catch (err: any) {
                errors++;
                outputChannel.appendLine(`[upload] Error for ${formatMemberPath(entry)}: ${err.message}`);
              }
            }

            if (cancelled) {
              vscode.window.showInformationMessage(
                `Upload cancelled. ${succeeded}/${selections.length} member(s) uploaded before cancelling.`
              );
            } else if (errors > 0) {
              vscode.window.showWarningMessage(
                `Uploaded ${succeeded}/${selections.length} member(s) to IBM i. ${errors} error(s) — see IBM i Checkout output panel.`
              );
              outputChannel.show();
            } else {
              vscode.window.showInformationMessage(
                `Successfully uploaded ${succeeded} member(s) to IBM i.`
              );
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.refreshAllRemote",
      async () => {
        const system = getSystemName();
        if (!system) {
          return;
        }
        const entries = service.getEntriesForSystem(system);
        if (entries.length === 0) {
          vscode.window.showInformationMessage("No checkouts to refresh.");
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing remote status...",
            cancellable: false,
          },
          async (progress) => {
            const total = entries.length;
            const { inSync, modified, conflict, errors } =
              await service.refreshAllRemoteStatus();
            progress.report({ increment: 100, message: `${total}/${total}` });

            if (errors > 0) {
              vscode.window.showWarningMessage(
                `Refresh complete: ${inSync} in sync, ${modified} modified, ${conflict} conflict(s), ${errors} error(s).`
              );
            } else if (conflict > 0) {
              vscode.window.showWarningMessage(
                `${conflict} member(s) have conflicting remote changes. ${modified} have local-only changes.`
              );
            } else if (modified > 0) {
              vscode.window.showInformationMessage(
                `${modified} member(s) have local changes pending merge. Remote is otherwise unchanged.`
              );
            } else {
              vscode.window.showInformationMessage(
                `All ${total} member(s) are in sync with the remote.`
              );
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.refreshSourceFileRemote",
      async (item: TreeItemType) => {
        if (item?.kind !== "sourceFile") {
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Refreshing ${item.library}/${item.sourceFile}...`,
            cancellable: false,
          },
          async () => {
            const { modified, conflict, errors } =
              await service.refreshSourceFileRemoteStatus(
                item.system,
                item.library,
                item.sourceFile
              );
            if (errors > 0) {
              vscode.window.showWarningMessage(
                `${item.library}/${item.sourceFile}: ${conflict} conflict(s), ${modified} modified, ${errors} error(s).`
              );
            } else if (conflict > 0) {
              vscode.window.showWarningMessage(
                `${item.library}/${item.sourceFile}: ${conflict} member(s) have conflicting remote changes.`
              );
            } else if (modified > 0) {
              vscode.window.showInformationMessage(
                `${item.library}/${item.sourceFile}: ${modified} member(s) have local changes pending merge.`
              );
            } else {
              vscode.window.showInformationMessage(
                `${item.library}/${item.sourceFile}: all members are in sync.`
              );
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.runAction",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length > 1) {
          const confirm = await vscode.window.showWarningMessage(
            `Run action against ${selections.length} selected members?`,
            { modal: true },
            "Run"
          );
          if (confirm !== "Run") {
            return;
          }
        }

        for (const sel of selections) {
          const localUri = vscode.Uri.file(sel.entry.localPath);
          await vscode.commands.executeCommand(
            "code-for-ibmi.runAction",
            localUri
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.refreshRemote",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        if (selections.length === 1) {
          const entry = selections[0].entry;
          try {
            const result = await service.refreshRemoteStatus(entry);
            const memberPath = formatMemberPath(entry);

            if (result === "in-sync") {
              vscode.window.showInformationMessage(
                `${memberPath} is in sync with the remote.`
              );
            } else if (result === "modified") {
              vscode.window.showInformationMessage(
                `${memberPath} has local changes not yet merged back. Remote is unchanged.`
              );
            } else {
              const choice = await vscode.window.showWarningMessage(
                `${memberPath} has changed on the remote IBM i and differs from your local copy.`,
                {
                  detail:
                    "Re-checkout will discard your local changes. Use Merge Back to review and combine the differences instead.",
                },
                "Merge Back",
                "Re-checkout (discard local changes)",
                "Cancel"
              );
              if (choice === "Re-checkout (discard local changes)") {
                await service.recheckout(entry);
                vscode.window.showInformationMessage(
                  `Re-checked out ${memberPath} from IBM i.`
                );
              } else if (choice === "Merge Back") {
                await mergeHandler.openMergeDiff(entry);
              }
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Refresh failed: ${err.message}`
            );
          }
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Refresh remote status for ${selections.length} selected members? This will contact the IBM i for each one.`,
          { modal: true },
          "Refresh"
        );
        if (confirm !== "Refresh") {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing remote status...",
            cancellable: false,
          },
          async () => {
            const entries = selections.map((s) => s.entry);
            const { inSync, modified, conflict, errors } =
              await service.refreshEntries(entries);

            if (errors > 0) {
              vscode.window.showWarningMessage(
                `Refresh complete: ${inSync} in sync, ${modified} modified, ${conflict} conflict(s), ${errors} error(s).`
              );
            } else if (conflict > 0) {
              vscode.window.showWarningMessage(
                `${conflict} member(s) have conflicting remote changes. ${modified} have local-only changes.`
              );
            } else if (modified > 0) {
              vscode.window.showInformationMessage(
                `${modified} member(s) have local changes pending merge. Remote is otherwise unchanged.`
              );
            } else {
              vscode.window.showInformationMessage(
                `All ${entries.length} member(s) are in sync with the remote.`
              );
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.discardCheckout",
      async (item: TreeItemType, allSelections?: TreeItemType[]) => {
        const selections = resolveMemberSelections(item, allSelections);
        if (selections.length === 0) {
          return;
        }

        const entries = selections.map((s) => s.entry);

        if (entries.length === 1) {
          try {
            await service.discardCheckout(entries[0]);
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Discard failed: ${err.message}`
            );
          }
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Delete ${entries.length} checked-out members and remove them from checkouts?`,
          {
            modal: true,
            detail: "Make sure you've already merged any changes back to the IBM i.",
          },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }

        try {
          await service.discardEntries(entries);
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Discard failed: ${err.message}`
          );
        }
      }
    )
  );

  let selectedForCompare: { entry: import("./types").CheckedOutMember } | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.revealInExplorer",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(item.entry.localPath)
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.selectForCompare",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        selectedForCompare = { entry: item.entry };
        await vscode.commands.executeCommand("setContext", "ibmi-checkout:hasCompareSelection", true);
        treeProvider.refresh();
        vscode.window.setStatusBarMessage(
          `Selected for compare: ${item.entry.memberName}.${item.entry.extension.toUpperCase()}`,
          3000
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.compareWithActive",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const rightUri = vscode.window.activeTextEditor?.document.uri;
        if (!rightUri) {
          vscode.window.showErrorMessage("No active editor to compare with.");
          return;
        }
        const localUri = vscode.Uri.file(item.entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          rightUri,
          `${item.entry.memberName}.${item.entry.extension.toUpperCase()} ↔ Active File`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.compareWithSelected",
      async (item: TreeItemType) => {
        if (item?.kind !== "member" || !selectedForCompare) {
          return;
        }
        const leftUri = vscode.Uri.file(selectedForCompare.entry.localPath);
        const rightUri = vscode.Uri.file(item.entry.localPath);
        const leftLabel = `${selectedForCompare.entry.memberName}.${selectedForCompare.entry.extension.toUpperCase()}`;
        const rightLabel = `${item.entry.memberName}.${item.entry.extension.toUpperCase()}`;
        await vscode.commands.executeCommand(
          "vscode.diff",
          leftUri,
          rightUri,
          `${leftLabel} ↔ ${rightLabel}`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.compareWithLocalFile",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const picks = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Compare",
        });
        if (!picks?.length) {
          return;
        }
        const localUri = vscode.Uri.file(item.entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          picks[0],
          `${item.entry.memberName}.${item.entry.extension.toUpperCase()} ↔ Local File`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.compareWithIfsFile",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const ifsPath = await vscode.window.showInputBox({
          prompt: "Enter the IFS file path (requires active IBM i connection)",
          placeHolder: "/home/user/file.rpgle",
        });
        if (!ifsPath?.trim()) {
          return;
        }
        const ifsUri = vscode.Uri.from({ scheme: "streamfile", path: ifsPath.trim() });
        const localUri = vscode.Uri.file(item.entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          ifsUri,
          `${item.entry.memberName}.${item.entry.extension.toUpperCase()} ↔ IFS`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.compareWithMember",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const entry = item.entry;
        const defaultValue = `${entry.library}/${entry.sourceFile}/${entry.memberName}.${entry.extension.toUpperCase()}`;
        const input = await vscode.window.showInputBox({
          prompt: "Enter member path (LIBRARY/FILE/NAME.EXT or ASP/LIBRARY/FILE/NAME.EXT)",
          placeHolder: "MYLIB/QRPGLESRC/MYPROG.RPGLE",
          value: defaultValue,
        });
        if (!input?.trim()) {
          return;
        }
        const parts = input.trim().toUpperCase().split("/");
        let memberUri: vscode.Uri;
        if (parts.length === 3) {
          memberUri = vscode.Uri.from({ scheme: "member", path: `/${parts[0]}/${parts[1]}/${parts[2]}` });
        } else if (parts.length === 4) {
          memberUri = vscode.Uri.from({ scheme: "member", path: `/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}` });
        } else {
          vscode.window.showErrorMessage("Invalid member path. Use format: LIBRARY/FILE/NAME.EXT");
          return;
        }
        const localUri = vscode.Uri.file(entry.localPath);
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          memberUri,
          `${entry.memberName}.${entry.extension.toUpperCase()} ↔ Member`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ibmi-checkout.copyMemberPath",
      async (item: TreeItemType) => {
        if (item?.kind !== "member") {
          return;
        }
        const path = formatMemberPath(item.entry);
        await vscode.env.clipboard.writeText(path);
        vscode.window.showInformationMessage(`Copied: ${path}`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-checkout.refreshView", () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-checkout.expandAll", async () => {
      const roots = treeProvider.getChildren();
      for (const root of roots) {
        await treeView.reveal(root, { expand: true, select: false, focus: false });
      }
    })
  );

  const updateSearchState = () => {
    const term = treeProvider.getSearchTerm();
    vscode.commands.executeCommand(
      "setContext",
      "ibmi-checkout:searchActive",
      term.length > 0
    );
    if (term) {
      const count = treeProvider.getFilteredCount();
      treeView.message = `Filtering by "${term}" — ${count} match${count === 1 ? "" : "es"}`;
    } else {
      treeView.message = undefined;
    }
  };

  const applySearchTerm = async (value: string) => {
    treeProvider.setSearchTerm(value);
    updateSearchState();

    // TreeItem.collapsibleState only sets a node's state the first time it
    // renders — VS Code caches expand/collapse per node after that, so
    // toggling collapsibleState alone won't reopen a node that was already
    // collapsed once. Force matching groups open explicitly instead.
    if (value) {
      const roots = treeProvider.getChildren();
      for (const root of roots) {
        await treeView.reveal(root, { expand: true, select: false, focus: false });
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-checkout.search", () => {
      const previousTerm = treeProvider.getSearchTerm();
      let accepted = false;

      const input = vscode.window.createInputBox();
      input.title = "Search Checked Out Members";
      input.placeholder = "Filter by member name";
      input.value = previousTerm;

      input.onDidChangeValue((value) => {
        void applySearchTerm(value);
      });

      input.onDidAccept(() => {
        accepted = true;
        input.hide();
      });

      input.onDidHide(() => {
        if (!accepted) {
          void applySearchTerm(previousTerm);
        }
        input.dispose();
      });

      input.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ibmi-checkout.clearSearch", () => {
      treeProvider.setSearchTerm("");
      updateSearchState();
    })
  );
}

async function checkoutMembersBatch(
  service: CheckoutService,
  system: string,
  memberInfoList: { library: string; sourceFile: string; memberName: string; extension: string }[],
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const alreadyCheckedOut = memberInfoList.filter(
    (m) => service.findEntry(system, m.library, m.sourceFile, m.memberName)
  );

  let redownloadBehavior: "skip" | "force" = "force";
  if (alreadyCheckedOut.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${alreadyCheckedOut.length} of ${memberInfoList.length} selected member(s) are already checked out. What would you like to do?`,
      "Re-download All",
      "Skip Existing",
      "Cancel"
    );
    if (!choice || choice === "Cancel") {
      return;
    }
    redownloadBehavior = choice === "Re-download All" ? "force" : "skip";
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Checking out members...", cancellable: true },
    async (progress, token) => {
      let succeeded = 0;
      let errors = 0;
      let cancelled = false;

      for (let i = 0; i < memberInfoList.length; i++) {
        if (token.isCancellationRequested) {
          cancelled = true;
          break;
        }
        const m = memberInfoList[i];
        progress.report({ message: `${m.memberName} (${i + 1}/${memberInfoList.length})` });
        try {
          await service.checkoutMember(
            m.library, m.sourceFile, m.memberName, m.extension,
            { redownloadBehavior, suppressAutoOpen: true }
          );
          succeeded++;
        } catch (err: any) {
          if (err.message !== "Checkout cancelled") {
            errors++;
            outputChannel.appendLine(`[checkout] Error for ${m.memberName}: ${err.message}`);
          }
        }
      }

      if (cancelled) {
        vscode.window.showInformationMessage(
          `Checkout cancelled. ${succeeded}/${memberInfoList.length} member(s) checked out from ${system} before cancelling.`
        );
      } else if (errors > 0) {
        vscode.window.showWarningMessage(
          `Checked out ${succeeded}/${memberInfoList.length} members from ${system}. ${errors} error(s) — see IBM i Checkout output panel.`
        );
        outputChannel.show();
      } else {
        vscode.window.showInformationMessage(
          `Checked out ${succeeded} member(s) from ${system}.`
        );
      }
    }
  );
}

function extractSourceFileInfo(node: any): { library: string; sourceFile: string } | undefined {
  if (!node) {
    return undefined;
  }

  // Pattern 1: Code for i SPF tree item — node.object has library/name
  if (node.object?.library && node.object?.name) {
    return { library: node.object.library, sourceFile: node.object.name };
  }

  // Pattern 2: node.path is "LIBRARY/FILE"
  if (typeof node.path === "string") {
    const parts = node.path.split("/").filter(Boolean);
    if (parts.length === 2) {
      return { library: parts[0], sourceFile: parts[1] };
    }
  }

  // Pattern 3: resourceUri — scheme "object", path "/LIBRARY/FILE.TYPE"
  if (node.resourceUri) {
    const uri =
      node.resourceUri instanceof vscode.Uri
        ? node.resourceUri
        : vscode.Uri.parse(node.resourceUri.toString());
    if (uri.scheme === "object") {
      const parts = uri.path.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const lastPart = parts[parts.length - 1];
        const dotIdx = lastPart.lastIndexOf(".");
        const fileName = dotIdx > 0 ? lastPart.substring(0, dotIdx) : lastPart;
        return { library: parts[0], sourceFile: fileName };
      }
    }
  }

  // Pattern 4: direct properties (library, file/name)
  if (node.library && (node.file || node.name)) {
    return { library: node.library, sourceFile: node.file || node.name };
  }

  return undefined;
}

function extractMemberInfo(node: any): {
  library: string;
  sourceFile: string;
  memberName: string;
  extension: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  let result: {
    library: string;
    sourceFile: string;
    memberName: string;
    extension: string;
  } | undefined;

  // Pattern 1: resourceUri based (member:// scheme) — most reliable for Code for i
  if (node.resourceUri) {
    const uri =
      node.resourceUri instanceof vscode.Uri
        ? node.resourceUri
        : vscode.Uri.parse(node.resourceUri.toString());

    if (uri.scheme === "member") {
      // member:// URIs: path is /LIB/SRCFILE/MEMBER.EXT
      const parts = uri.path.split("/").filter(Boolean);
      if (parts.length >= 3) {
        const lastPart = parts[parts.length - 1];
        const dotIdx = lastPart.lastIndexOf(".");
        const memberName = dotIdx > 0 ? lastPart.substring(0, dotIdx) : lastPart;
        const ext = dotIdx > 0 ? lastPart.substring(dotIdx + 1) : "mbr";
        result = {
          library: parts[0],
          sourceFile: parts[1],
          memberName,
          extension: ext.toLowerCase(),
        };
      }
    }
  }

  // Pattern 2: node has path property like "/QSYS.LIB/MYLIB.LIB/QRPGLESRC.FILE/MYPROG.MBR"
  if (!result && node.path && typeof node.path === "string") {
    const match = node.path.match(
      /\/QSYS\.LIB\/([^.]+)\.LIB\/([^.]+)\.FILE\/([^.]+)\.(\w+)/i
    );
    if (match) {
      result = {
        library: match[1],
        sourceFile: match[2],
        memberName: match[3],
        extension: match[4].toUpperCase() === "MBR" ? "mbr" : match[4].toLowerCase(),
      };
    }
  }

  // Pattern 3: node has direct properties (library, file, name)
  if (!result && node.library && node.file && node.name) {
    result = {
      library: node.library,
      sourceFile: node.file,
      memberName: node.name,
      extension: node.extension || "mbr",
    };
  }

  // Pattern 4: node has member property with nested info
  if (!result && node.member) {
    const lib = node.member.library || node.library;
    const file = node.member.file || node.member.sourceFile || node.file;
    const name = node.member.name || node.member.member;
    const ext = node.member.extension || "mbr";

    if (lib && file && name) {
      result = {
        library: lib,
        sourceFile: file,
        memberName: name,
        extension: ext.toLowerCase(),
      };
    }
  }

  // Pattern 5: Code for i MemberItem — has _filter with library/object
  if (!result && node._filter) {
    const lib = node._filter.library;
    const file = node._filter.object;
    const name = node.label || node.name;
    const ext = node.extension || "mbr";

    if (lib && file && name) {
      result = {
        library: lib,
        sourceFile: file,
        memberName: name,
        extension: ext.toLowerCase(),
      };
    }
  }

  // Validate: all fields must be non-empty strings
  if (result) {
    if (!result.library || !result.sourceFile || !result.memberName || !result.extension) {
      outputChannel.appendLine(
        `Extracted but has undefined fields: ${JSON.stringify(result)}`
      );
      return undefined;
    }
  }

  return result;
}


export function deactivate(): void {
  // cleanup handled by disposables
}
