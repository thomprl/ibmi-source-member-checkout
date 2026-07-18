import * as vscode from "vscode";

export interface IBMiConnection {
  currentHost: string;
}

export interface IBMiMember {
  library: string;
  file: string;
  name: string;
  extension: string;
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
  getMemberList(filter: {
    library: string;
    sourceFile: string;
  }): Promise<IBMiMember[]>;
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

