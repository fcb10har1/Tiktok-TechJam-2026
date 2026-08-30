import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

export interface WorkspaceManifestLimits {
  maxEntries: number;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface WorkspaceManifestEntry {
  path: string;
  size: number;
  digest: string;
}

export interface WorkspaceManifest {
  entries: Map<string, WorkspaceManifestEntry>;
  skippedPaths: Set<string>;
  enumerationComplete: boolean;
  available: boolean;
  capturedAt: string;
}

export type WorkspaceDiffStatus = "complete" | "partial" | "unavailable";

export interface WorkspaceMutation {
  kind: "create" | "modify" | "delete";
  path: string;
}

export interface WorkspaceDiff {
  mutations: WorkspaceMutation[];
  status: WorkspaceDiffStatus;
  capturedAt: string;
}

export const DEFAULT_WORKSPACE_MANIFEST_LIMITS: WorkspaceManifestLimits = {
  maxEntries: 20_000,
  maxFiles: 10_000,
  maxDepth: 64,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

interface HashResult {
  entry: WorkspaceManifestEntry | null;
  bytesRead: number;
}

function safeRelativePath(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(".." + path.sep)
  ) {
    return null;
  }
  const workspacePath = relative.split(path.sep).join("/");
  if (
    workspacePath.length > 1_024 ||
    workspacePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(workspacePath) ||
    workspacePath.split("/").some((component) => !component || component === "..")
  ) {
    return null;
  }
  return workspacePath;
}

async function hashRegularFile(
  absolutePath: string,
  workspacePath: string,
  remainingBytes: number,
  maxFileBytes: number,
): Promise<HashResult> {
  let handle: FileHandle | null = null;
  let bytesRead = 0;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > maxFileBytes ||
      before.size > remainingBytes
    ) {
      return { entry: null, bytesRead };
    }

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.length, before.size - position);
      const result = await handle.read(buffer, 0, requested, position);
      if (result.bytesRead === 0) break;
      digest.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return { entry: null, bytesRead };
    }
    return {
      entry: {
        path: workspacePath,
        size: before.size,
        digest: digest.digest("hex"),
      },
      bytesRead,
    };
  } catch {
    return { entry: null, bytesRead };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function captureWorkspaceManifest(
  workspacePath: string,
  limits: WorkspaceManifestLimits = DEFAULT_WORKSPACE_MANIFEST_LIMITS,
  clock: () => string = () => new Date().toISOString(),
): Promise<WorkspaceManifest> {
  const manifest: WorkspaceManifest = {
    entries: new Map(),
    skippedPaths: new Set(),
    enumerationComplete: true,
    available: false,
    capturedAt: clock(),
  };
  let canonicalRoot: string;
  try {
    const unresolvedRoot = path.resolve(workspacePath);
    const rootStats = await lstat(unresolvedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return manifest;
    canonicalRoot = await realpath(unresolvedRoot);
    manifest.available = true;
  } catch {
    return manifest;
  }

  let visitedEntries = 0;
  let visitedFiles = 0;
  let totalBytesRead = 0;
  const pending = [{ absolutePath: canonicalRoot, depth: 0 }];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let children;
    try {
      children = await readdir(directory.absolutePath, { withFileTypes: true });
      children.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    } catch {
      manifest.enumerationComplete = false;
      continue;
    }

    for (const child of children) {
      visitedEntries += 1;
      if (visitedEntries > limits.maxEntries) {
        manifest.enumerationComplete = false;
        pending.length = 0;
        break;
      }
      const absolutePath = path.join(directory.absolutePath, child.name);
      const workspaceRelativePath = safeRelativePath(canonicalRoot, absolutePath);
      if (!workspaceRelativePath) {
        manifest.enumerationComplete = false;
        continue;
      }

      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch {
        manifest.skippedPaths.add(workspaceRelativePath);
        manifest.enumerationComplete = false;
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (directory.depth >= limits.maxDepth) {
          manifest.enumerationComplete = false;
          continue;
        }
        pending.push({ absolutePath, depth: directory.depth + 1 });
        continue;
      }
      if (!stats.isFile()) continue;

      visitedFiles += 1;
      if (visitedFiles > limits.maxFiles) {
        manifest.enumerationComplete = false;
        pending.length = 0;
        break;
      }
      if (
        stats.size > limits.maxFileBytes ||
        stats.size > limits.maxTotalBytes - totalBytesRead
      ) {
        manifest.skippedPaths.add(workspaceRelativePath);
        continue;
      }

      const hashed = await hashRegularFile(
        absolutePath,
        workspaceRelativePath,
        limits.maxTotalBytes - totalBytesRead,
        limits.maxFileBytes,
      );
      totalBytesRead += hashed.bytesRead;
      if (hashed.entry) manifest.entries.set(workspaceRelativePath, hashed.entry);
      else manifest.skippedPaths.add(workspaceRelativePath);
    }
  }
  return manifest;
}

function diffStatus(
  before: WorkspaceManifest,
  after: WorkspaceManifest,
): WorkspaceDiffStatus {
  if (!before.available || !after.available) return "unavailable";
  if (
    !before.enumerationComplete ||
    !after.enumerationComplete ||
    before.skippedPaths.size > 0 ||
    after.skippedPaths.size > 0
  ) {
    return "partial";
  }
  return "complete";
}

export function compareWorkspaceManifests(
  before: WorkspaceManifest,
  after: WorkspaceManifest,
): WorkspaceDiff {
  const mutations: WorkspaceMutation[] = [];
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const workspacePath of [...paths].sort()) {
    if (
      before.skippedPaths.has(workspacePath) ||
      after.skippedPaths.has(workspacePath)
    ) {
      continue;
    }
    const previous = before.entries.get(workspacePath);
    const current = after.entries.get(workspacePath);
    if (previous && current) {
      if (previous.digest !== current.digest) {
        mutations.push({ kind: "modify", path: workspacePath });
      }
      continue;
    }
    if (!previous && current && before.enumerationComplete && before.available) {
      mutations.push({ kind: "create", path: workspacePath });
      continue;
    }
    if (previous && !current && after.enumerationComplete && after.available) {
      mutations.push({ kind: "delete", path: workspacePath });
    }
  }
  return {
    mutations,
    status: diffStatus(before, after),
    capturedAt: after.capturedAt,
  };
}
