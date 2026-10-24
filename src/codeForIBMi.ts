import * as vscode from "vscode";

export interface IBMiConnection {
  currentHost: string;
  runCommand(command: {
    command: string;
    environment?: "ile" | "qsh" | "pase";
  }): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface IBMiMember {
  library: string;
  file: string;
  name: string;
  extension: string;
  text?: string;
}

export interface IBMiContent {
  downloadMemberContent(
    library: string,
    sourceFile: string,
    member: string
  ): Promise<string>;
  uploadMemberContent(
    library: string,
    sourceFile: string,
    member: string,
    content: string
  ): Promise<boolean>;
  checkObject(object: {
    library: string;
    name: string;
    type: string;
    member?: string;
  }): Promise<boolean>;
  getMemberList(filter: {
    library: string;
    sourceFile: string;
    members?: string;
  }): Promise<IBMiMember[]>;
  runSQL(statement: string): Promise<Record<string, unknown>[]>;
}

export interface IBMiInstance {
  getConnection(): IBMiConnection | undefined;
  getContent(): IBMiContent | undefined;
  onEvent(
    event: "connected" | "disconnected",
    callback: () => void
  ): vscode.Disposable;
}

export interface CodeForIBMiExports {
  instance: IBMiInstance;
}

let cachedExports: CodeForIBMiExports | undefined;

export function getCodeForIBMi(): CodeForIBMiExports | undefined {
  if (cachedExports) {
    return cachedExports;
  }

  const ext = vscode.extensions.getExtension<CodeForIBMiExports>(
    "halcyontechltd.code-for-ibmi"
  );
  if (!ext) {
    return undefined;
  }

  if (!ext.isActive) {
    return undefined;
  }

  cachedExports = ext.exports;
  return cachedExports;
}

export function getInstance(): IBMiInstance | undefined {
  return getCodeForIBMi()?.instance;
}

export function getConnection(): IBMiConnection | undefined {
  return getInstance()?.getConnection();
}

export function getContent(): IBMiContent | undefined {
  return getInstance()?.getContent();
}

export function getSystemName(): string | undefined {
  return getConnection()?.currentHost;
}

export async function downloadMemberContent(
  library: string,
  sourceFile: string,
  member: string
): Promise<string> {
  const content = getContent();
  if (!content) {
    throw new Error("Not connected to IBM i");
  }
  return content.downloadMemberContent(library, sourceFile, member);
}

export async function uploadMemberContent(
  library: string,
  sourceFile: string,
  member: string,
  fileContent: string
): Promise<boolean> {
  const content = getContent();
  if (!content) {
    throw new Error("Not connected to IBM i");
  }
  return content.uploadMemberContent(library, sourceFile, member, fileContent);
}

export async function listSourceFileMembers(
  library: string,
  sourceFile: string
): Promise<IBMiMember[]> {
  const content = getContent();
  if (!content) {
    throw new Error("Not connected to IBM i");
  }
  return content.getMemberList({ library, sourceFile });
}


export async function memberExists(
  library: string,
  sourceFile: string,
  member: string
): Promise<boolean> {
  const content = getContent();
  if (!content) {
    throw new Error("Not connected to IBM i");
  }
  return content.checkObject({
    library,
    name: sourceFile,
    type: "*FILE",
    member,
  });
}

export async function sourceFileExists(
  library: string,
  sourceFile: string
): Promise<boolean> {
  const content = getContent();
  if (!content) {
    throw new Error("Not connected to IBM i");
  }
  return content.checkObject({ library, name: sourceFile, type: "*FILE" });
}

/** Looks up a member's text. Returns undefined if it can't be determined. */
export async function getMemberText(
  library: string,
  sourceFile: string,
  member: string
): Promise<string | undefined> {
  const content = getContent();
  if (!content) {
    return undefined;
  }
  try {
    const members = await content.getMemberList({ library, sourceFile, members: member });
    const match = members.find((m) => m.name.toUpperCase() === member.toUpperCase());
    return match ? (match.text ?? "").trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates an empty source member. The source type comes from the file
 * extension; "mbr" (no real type) leaves it unset.
 */
export async function createMember(
  library: string,
  sourceFile: string,
  member: string,
  extension: string
): Promise<void> {
  const connection = getConnection();
  if (!connection) {
    throw new Error("Not connected to IBM i");
  }
  const srcType =
    extension && extension.toLowerCase() !== "mbr"
      ? extension.toUpperCase().substring(0, 10)
      : "*NONE";
  const command = `ADDPFM FILE(${library}/${sourceFile}) MBR(${member}) SRCTYPE(${srcType})`;
  const result = await connection.runCommand({ command, environment: "ile" });
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed${message ? `: ${message}` : ""}`);
  }
}

/**
 * Maximum source line length for a source file (record length minus the
 * 12 bytes of sequence number and date). Undefined if it can't be determined.
 */
export async function getSourceLineLength(
  library: string,
  sourceFile: string
): Promise<number | undefined> {
  const content = getContent();
  if (!content) {
    return undefined;
  }
  const quote = (value: string) => `'${value.toUpperCase().replace(/'/g, "''")}'`;
  try {
    const rows = await content.runSQL(
      `SELECT ROW_LENGTH FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${quote(library)} AND SYSTEM_TABLE_NAME = ${quote(sourceFile)}`
    );
    const rowLength = Number(rows[0]?.ROW_LENGTH);
    return rowLength > 12 ? rowLength - 12 : undefined;
  } catch {
    return undefined;
  }
}
