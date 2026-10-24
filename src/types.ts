import * as vscode from "vscode";

export interface CheckedOutMember {
  id: string;
  system: string;
  library: string;
  sourceFile: string;
  memberName: string;
  extension: string;
  /** Member text (description) from the IBM i, when known. */
  memberText?: string;
  localPath: string;
  checkedOutAt: string;
  lastCheckedAt?: string;
  remoteHashAtCheckout: string;
  status: CheckoutStatus;
}

export type CheckoutStatus =
  | "checked-out"
  | "merged"
  | "modified"
  | "conflict"
  | "in-sync"
  | "remote-missing"
  /** Created locally (e.g. by a tool or AI) and not yet on the IBM i. */
  | "local-only"
  /** The local file is gone (deleted, renamed or moved outside the extension). */
  | "local-missing";

export interface CheckoutIndex {
  version: number;
  entries: CheckedOutMember[];
}

export interface RefreshTally {
  inSync: number;
  modified: number;
  conflict: number;
  missing: number;
  localOnly: number;
  localMissing: number;
  errors: number;
}

/** A file in the checkout folder that isn't in the checkout index. */
export interface UntrackedFile {
  uri: vscode.Uri;
  library: string;
  sourceFile: string;
  memberName: string;
  extension: string;
  /** A checkout of the same member whose local file is missing; adopting re-links it. */
  replaces?: CheckedOutMember;
}

export interface UntrackedScanResult {
  files: UntrackedFile[];
  /** Files that look like members but can't be adopted, with the reason. */
  skipped: { uri: vscode.Uri; reason: string }[];
}

export interface RelocateResult {
  moved: { entry: CheckedOutMember; from: vscode.Uri; to: vscode.Uri }[];
  /** Local file was already gone; the entry now points at the new folder. */
  missing: CheckedOutMember[];
  /** A file already existed at the destination and the user chose not to overwrite. */
  skipped: CheckedOutMember[];
  failed: { entry: CheckedOutMember; error: string }[];
}

export function buildCheckoutId(
  system: string,
  library: string,
  sourceFile: string,
  memberName: string
): string {
  return `${system}_${library}_${sourceFile}_${memberName}`.toUpperCase();
}

export function buildLocalFileName(entry: CheckedOutMember): string {
  return `${entry.memberName}.${entry.extension}`.toUpperCase();
}

export function sanitizeSystemName(system: string): string {
  return system.replace(/[\\/:*?"<>|]/g, "_");
}

export function formatMemberPath(entry: CheckedOutMember): string {
  return `${entry.library}/${entry.sourceFile}(${entry.memberName})`;
}

export type TreeItemType =
  | { kind: "library"; system: string; library: string }
  | { kind: "sourceFile"; system: string; library: string; sourceFile: string }
  | { kind: "member"; entry: CheckedOutMember };

/** Compares file paths, ignoring case on Windows. */
export function isSamePath(a: vscode.Uri, b: vscode.Uri): boolean {
  return pathKey(a.fsPath) === pathKey(b.fsPath);
}

export function pathKey(fsPath: string): string {
  const normalized = fsPath.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
