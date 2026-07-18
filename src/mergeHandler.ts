import * as vscode from "vscode";
import { CheckedOutMember, formatMemberPath } from "./types";

export class MergeHandler {

  async openMergeDiff(entry: CheckedOutMember): Promise<void> {
    const memberPath = formatMemberPath(entry);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Opening merge diff for ${memberPath}...`,
        cancellable: false,
      },
      async () => {
        const memberUri = vscode.Uri.from({
          scheme: "member",
          path: `/${entry.library}/${entry.sourceFile}/${entry.memberName}.${entry.extension.toUpperCase()}`,
          query: "readonly=false",
        });

        const localUri = vscode.Uri.file(entry.localPath);

        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          memberUri,
          `${entry.memberName} — Local ↔ Remote`
        );
      }
    );
  }
}
