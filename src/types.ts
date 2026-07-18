export interface CheckedOutMember {
  id: string;
  system: string;
  library: string;
  sourceFile: string;
  memberName: string;
  extension: string;
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
  | "in-sync";

export interface CheckoutIndex {
  version: number;
  entries: CheckedOutMember[];
}

export interface RefreshTally {
  inSync: number;
  modified: number;
  conflict: number;
  errors: number;
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
  | { kind: "sourceFile"; system: string; library: string; sourceFile: string }
  | { kind: "member"; entry: CheckedOutMember };
