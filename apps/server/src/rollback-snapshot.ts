import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Agent } from "./types.js";
import type { WorkspaceManifest } from "./workspace-manifest.js";

export interface RollbackSnapshotLimits {
  maxEntries: number;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxSymlinkTargetBytes: number;
  maxManifestBytes: number;
}

export const DEFAULT_ROLLBACK_SNAPSHOT_LIMITS: RollbackSnapshotLimits = {
  maxEntries: 20_000,
  maxFiles: 10_000,
  maxDepth: 64,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxSymlinkTargetBytes: 4 * 1024,
  maxManifestBytes: 8 * 1024 * 1024,
};

const identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const relativePath = z.string().min(1).max(1_024);
const fileEntrySchema = z
  .object({
    type: z.literal("file"),
    path: relativePath,
    mode: z.number().int().min(0).max(0o777),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const directoryEntrySchema = z
  .object({
    type: z.literal("directory"),
    path: relativePath,
    mode: z.number().int().min(0).max(0o777),
  })
  .strict();
const symlinkEntrySchema = z
  .object({
    type: z.literal("symlink"),
    path: relativePath,
    target: z.string(),
  })
  .strict();
const snapshotManifestSchema = z
  .object({
    version: z.literal(1),
    agentId: identifier,
    runId: identifier,
    createdAt: z.string(),
    rootMode: z.number().int().min(0).max(0o777),
    entries: z
      .array(
        z.discriminatedUnion("type", [
          fileEntrySchema,
          directoryEntrySchema,
          symlinkEntrySchema,
        ]),
      )
      .max(DEFAULT_ROLLBACK_SNAPSHOT_LIMITS.maxEntries),
  })
  .strict();

type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
type SnapshotEntry = SnapshotManifest["entries"][number];
type FileSnapshotEntry = Extract<SnapshotEntry, { type: "file" }>;

const recoveryJournalSchema = z
  .object({
    version: z.literal(1),
    transactionId: identifier,
    agentId: identifier,
    runId: identifier,
    stageName: z.string().min(1).max(240),
    backupName: z.string().min(1).max(240),
  })
  .strict();

type RecoveryJournal = z.infer<typeof recoveryJournalSchema>;

export type RollbackSnapshotFailureCode =
  | "snapshot_failed"
  | "snapshot_missing"
  | "snapshot_corrupt"
  | "recovery_failed";

export class RollbackSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: RollbackSnapshotFailureCode,
  ) {
    super(message);
    this.name = "RollbackSnapshotError";
  }
}

export interface CreatedRollbackSnapshot {
  snapshotId: string;
  createdAt: string;
  fileEntries: Map<string, { size: number; digest: string }>;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeWorkspacePath(value: string, maxDepth: number): string | null {
  if (
    !value ||
    value.length > 1_024 ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  const components = value.split("/");
  if (
    components.length > maxDepth ||
    components.some(
      (component) => !component || component === "." || component === "..",
    ) ||
    components.join("/") !== value
  ) {
    return null;
  }
  return value;
}

function resolveInside(root: string, workspacePath: string): string {
  const safePath = safeWorkspacePath(
    workspacePath,
    DEFAULT_ROLLBACK_SNAPSHOT_LIMITS.maxDepth,
  );
  if (!safePath) {
    throw new RollbackSnapshotError(
      "Rollback snapshot contains an invalid path",
      "snapshot_corrupt",
    );
  }
  const resolved = path.resolve(root, ...safePath.split("/"));
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(".." + path.sep)
  ) {
    throw new RollbackSnapshotError(
      "Rollback snapshot path escaped its root",
      "snapshot_corrupt",
    );
  }
  return resolved;
}

async function pathKind(
  targetPath: string,
): Promise<"missing" | "directory" | "other"> {
  try {
    const stats = await lstat(targetPath);
    return stats.isDirectory() && !stats.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function removeTreeNoFollow(targetPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await unlink(targetPath);
    return;
  }
  const children = await readdir(targetPath);
  for (const child of children) {
    await removeTreeNoFollow(path.join(targetPath, child));
  }
  await rmdir(targetPath);
}

async function copyAndHashRegularFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number,
  expected?: FileSnapshotEntry,
): Promise<{ size: number; digest: string; mode: number }> {
  let source: FileHandle | null = null;
  let destination: FileHandle | null = null;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await source.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > maximumBytes
    ) {
      throw new RollbackSnapshotError(
        "Workspace contains an unsupported or oversized file",
        expected ? "snapshot_corrupt" : "snapshot_failed",
      );
    }
    if (expected && before.size !== expected.size) {
      throw new RollbackSnapshotError(
        "Rollback snapshot file size does not match its manifest",
        "snapshot_corrupt",
      );
    }

    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.length, before.size - position);
      const read = await source.read(buffer, 0, requested, position);
      if (read.bytesRead === 0) break;
      digest.update(buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          read.bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += read.bytesRead;
    }
    const after = await source.stat();
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new RollbackSnapshotError(
        "Workspace changed while its rollback snapshot was being created",
        expected ? "snapshot_corrupt" : "snapshot_failed",
      );
    }
    const hash = digest.digest("hex");
    if (expected && hash !== expected.sha256) {
      throw new RollbackSnapshotError(
        "Rollback snapshot file digest does not match its manifest",
        "snapshot_corrupt",
      );
    }
    await destination.sync();
    const mode = before.mode & 0o777;
    await chmod(destinationPath, expected?.mode ?? 0o600);
    return { size: before.size, digest: hash, mode };
  } catch (error) {
    if (error instanceof RollbackSnapshotError) throw error;
    throw new RollbackSnapshotError(
      expected
        ? "Rollback snapshot is missing or corrupt"
        : "Rollback snapshot could not be created",
      expected ? "snapshot_corrupt" : "snapshot_failed",
    );
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}

function validateManifest(
  value: unknown,
  agentId: string,
  runId: string,
  limits: RollbackSnapshotLimits,
): SnapshotManifest {
  const parsed = snapshotManifestSchema.safeParse(value);
  if (!parsed.success || parsed.data.agentId !== agentId || parsed.data.runId !== runId) {
    throw new RollbackSnapshotError(
      "Rollback snapshot metadata is invalid",
      "snapshot_corrupt",
    );
  }
  if (parsed.data.entries.length > limits.maxEntries) {
    throw new RollbackSnapshotError(
      "Rollback snapshot exceeds safe limits",
      "snapshot_corrupt",
    );
  }
  const entries = new Map<string, SnapshotEntry>();
  let files = 0;
  let totalBytes = 0;
  for (const entry of parsed.data.entries) {
    const safePath = safeWorkspacePath(entry.path, limits.maxDepth);
    if (!safePath || entries.has(safePath)) {
      throw new RollbackSnapshotError(
        "Rollback snapshot contains duplicate or invalid paths",
        "snapshot_corrupt",
      );
    }
    if (entry.type === "file") {
      files += 1;
      totalBytes += entry.size;
      if (entry.size > limits.maxFileBytes) {
        throw new RollbackSnapshotError(
          "Rollback snapshot exceeds safe limits",
          "snapshot_corrupt",
        );
      }
    } else if (
      entry.type === "symlink" &&
      Buffer.byteLength(entry.target) > limits.maxSymlinkTargetBytes
    ) {
      throw new RollbackSnapshotError(
        "Rollback snapshot contains an oversized symlink target",
        "snapshot_corrupt",
      );
    }
    entries.set(safePath, entry);
  }
  if (files > limits.maxFiles || totalBytes > limits.maxTotalBytes) {
    throw new RollbackSnapshotError(
      "Rollback snapshot exceeds safe limits",
      "snapshot_corrupt",
    );
  }
  for (const entry of entries.values()) {
    const components = entry.path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const ancestor = entries.get(components.slice(0, index).join("/"));
      if (!ancestor || ancestor.type !== "directory") {
        throw new RollbackSnapshotError(
          "Rollback snapshot contains invalid entry ancestry",
          "snapshot_corrupt",
        );
      }
    }
  }
  return parsed.data;
}

async function readBoundedJson(
  filePath: string,
  maximumBytes: number,
  missingCode: RollbackSnapshotFailureCode,
): Promise<unknown> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximumBytes) {
      throw new Error("invalid metadata file");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof RollbackSnapshotError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new RollbackSnapshotError(
      missing ? "Rollback snapshot is missing" : "Rollback snapshot is corrupt",
      missing ? missingCode : "snapshot_corrupt",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class RollbackSnapshotManager {
  private readonly snapshotRoot: string;
  private readonly recoveryRoot: string;
  private readonly workspaceRoot: string;

  constructor(
    dataDirectory: string,
    workspaceRoot: string,
    private readonly limits: RollbackSnapshotLimits =
      DEFAULT_ROLLBACK_SNAPSHOT_LIMITS,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    this.snapshotRoot = path.resolve(dataDirectory, "rollback-snapshots");
    this.recoveryRoot = path.join(this.snapshotRoot, ".recovery");
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async initialize(agents: readonly Agent[]): Promise<void> {
    const snapshotRelativeToWorkspaces = path.relative(
      this.workspaceRoot,
      this.snapshotRoot,
    );
    const workspacesRelativeToSnapshots = path.relative(
      this.snapshotRoot,
      this.workspaceRoot,
    );
    if (
      !snapshotRelativeToWorkspaces ||
      !workspacesRelativeToSnapshots ||
      (!path.isAbsolute(snapshotRelativeToWorkspaces) &&
        snapshotRelativeToWorkspaces !== ".." &&
        !snapshotRelativeToWorkspaces.startsWith(".." + path.sep)) ||
      (!path.isAbsolute(workspacesRelativeToSnapshots) &&
        workspacesRelativeToSnapshots !== ".." &&
        !workspacesRelativeToSnapshots.startsWith(".." + path.sep))
    ) {
      throw new RollbackSnapshotError(
        "Rollback snapshots must be stored outside Agent workspaces",
        "recovery_failed",
      );
    }
    const workspaceRootStats = await lstat(this.workspaceRoot);
    if (
      !workspaceRootStats.isDirectory() ||
      workspaceRootStats.isSymbolicLink()
    ) {
      throw new RollbackSnapshotError(
        "Configured workspace root is not a safe directory",
        "recovery_failed",
      );
    }
    await mkdir(this.snapshotRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.recoveryRoot, { recursive: true, mode: 0o700 });
    await this.recoverInterruptedRestores(agents);
  }

  async create(
    agentId: string,
    runId: string,
    workspacePath: string,
  ): Promise<CreatedRollbackSnapshot> {
    this.assertIdentifier(agentId);
    this.assertIdentifier(runId);
    const canonicalWorkspace = await this.canonicalWorkspace(agentId, workspacePath);
    const rootStats = await lstat(canonicalWorkspace);
    const createdAt = this.clock();
    const agentSnapshotRoot = path.join(this.snapshotRoot, agentId);
    const finalRoot = path.join(agentSnapshotRoot, runId);
    const temporaryRoot = path.join(
      agentSnapshotRoot,
      ".tmp-" + runId + "-" + randomUUID(),
    );
    const payloadRoot = path.join(temporaryRoot, "files");
    await mkdir(agentSnapshotRoot, { recursive: true, mode: 0o700 });
    if ((await pathKind(finalRoot)) !== "missing") {
      throw new RollbackSnapshotError(
        "Rollback snapshot already exists",
        "snapshot_failed",
      );
    }
    await mkdir(payloadRoot, { recursive: true, mode: 0o700 });

    const entries: SnapshotEntry[] = [];
    const fileEntries = new Map<string, { size: number; digest: string }>();
    let visitedEntries = 0;
    let visitedFiles = 0;
    let totalBytes = 0;
    const pending = [{ source: canonicalWorkspace, relative: "", depth: 0 }];
    try {
      while (pending.length > 0) {
        const directory = pending.pop()!;
        const children = await readdir(directory.source, { withFileTypes: true });
        children.sort((left, right) => lexicalCompare(left.name, right.name));
        for (const child of children) {
          visitedEntries += 1;
          if (visitedEntries > this.limits.maxEntries) {
            throw new RollbackSnapshotError(
              "Workspace exceeds rollback snapshot entry limits",
              "snapshot_failed",
            );
          }
          const workspacePath = directory.relative
            ? directory.relative + "/" + child.name
            : child.name;
          if (!safeWorkspacePath(workspacePath, this.limits.maxDepth)) {
            throw new RollbackSnapshotError(
              "Workspace contains an unsupported path",
              "snapshot_failed",
            );
          }
          const sourcePath = path.join(directory.source, child.name);
          const stats = await lstat(sourcePath);
          if (stats.isSymbolicLink()) {
            const target = await readlink(sourcePath);
            if (Buffer.byteLength(target) > this.limits.maxSymlinkTargetBytes) {
              throw new RollbackSnapshotError(
                "Workspace contains an oversized symlink target",
                "snapshot_failed",
              );
            }
            entries.push({ type: "symlink", path: workspacePath, target });
            continue;
          }
          if (stats.isDirectory()) {
            if (directory.depth >= this.limits.maxDepth) {
              throw new RollbackSnapshotError(
                "Workspace exceeds rollback snapshot depth limits",
                "snapshot_failed",
              );
            }
            entries.push({
              type: "directory",
              path: workspacePath,
              mode: stats.mode & 0o777,
            });
            await mkdir(resolveInside(payloadRoot, workspacePath), {
              recursive: false,
              mode: 0o700,
            });
            pending.push({
              source: sourcePath,
              relative: workspacePath,
              depth: directory.depth + 1,
            });
            continue;
          }
          if (!stats.isFile() || stats.nlink !== 1) {
            throw new RollbackSnapshotError(
              "Workspace contains an unsupported special file",
              "snapshot_failed",
            );
          }
          visitedFiles += 1;
          if (
            visitedFiles > this.limits.maxFiles ||
            stats.size > this.limits.maxFileBytes ||
            totalBytes + stats.size > this.limits.maxTotalBytes
          ) {
            throw new RollbackSnapshotError(
              "Workspace exceeds rollback snapshot file limits",
              "snapshot_failed",
            );
          }
          const copied = await copyAndHashRegularFile(
            sourcePath,
            resolveInside(payloadRoot, workspacePath),
            this.limits.maxFileBytes,
          );
          totalBytes += copied.size;
          entries.push({
            type: "file",
            path: workspacePath,
            mode: copied.mode,
            size: copied.size,
            sha256: copied.digest,
          });
          fileEntries.set(workspacePath, {
            size: copied.size,
            digest: copied.digest,
          });
        }
      }
      entries.sort((left, right) => lexicalCompare(left.path, right.path));
      const manifest: SnapshotManifest = {
        version: 1,
        agentId,
        runId,
        createdAt,
        rootMode: rootStats.mode & 0o777,
        entries,
      };
      const serialized = JSON.stringify(manifest, null, 2) + "\n";
      if (Buffer.byteLength(serialized) > this.limits.maxManifestBytes) {
        throw new RollbackSnapshotError(
          "Workspace exceeds rollback snapshot metadata limits",
          "snapshot_failed",
        );
      }
      await writeFile(path.join(temporaryRoot, "snapshot.json"), serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryRoot, finalRoot);
      return { snapshotId: runId, createdAt, fileEntries };
    } catch (error) {
      await removeTreeNoFollow(temporaryRoot).catch(() => undefined);
      if (error instanceof RollbackSnapshotError) throw error;
      throw new RollbackSnapshotError(
        "Rollback snapshot could not be created",
        "snapshot_failed",
      );
    }
  }

  matchesPreManifest(
    snapshot: CreatedRollbackSnapshot,
    manifest: WorkspaceManifest,
  ): boolean {
    if (
      !manifest.available ||
      !manifest.enumerationComplete ||
      manifest.skippedPaths.size > 0 ||
      manifest.entries.size !== snapshot.fileEntries.size
    ) {
      return false;
    }
    for (const [workspacePath, expected] of snapshot.fileEntries) {
      const observed = manifest.entries.get(workspacePath);
      if (
        !observed ||
        observed.size !== expected.size ||
        observed.digest !== expected.digest
      ) {
        return false;
      }
    }
    return true;
  }

  async restore(
    agentId: string,
    runId: string,
    snapshotId: string,
    workspacePath: string,
  ): Promise<void> {
    this.assertIdentifier(agentId);
    this.assertIdentifier(runId);
    if (snapshotId !== runId) {
      throw new RollbackSnapshotError(
        "Rollback snapshot identity is invalid",
        "snapshot_corrupt",
      );
    }
    const canonicalWorkspace = await this.canonicalWorkspace(agentId, workspacePath);
    const snapshotRoot = path.join(this.snapshotRoot, agentId, snapshotId);
    const manifestValue = await readBoundedJson(
      path.join(snapshotRoot, "snapshot.json"),
      this.limits.maxManifestBytes,
      "snapshot_missing",
    );
    const manifest = validateManifest(
      manifestValue,
      agentId,
      runId,
      this.limits,
    );
    const payloadRoot = path.join(snapshotRoot, "files");
    if ((await pathKind(payloadRoot)) !== "directory") {
      throw new RollbackSnapshotError(
        "Rollback snapshot payload is missing or corrupt",
        "snapshot_corrupt",
      );
    }

    const transactionId = randomUUID();
    const stageName = ".ultr0n-rollback-stage-" + agentId + "-" + transactionId;
    const backupName = ".ultr0n-rollback-backup-" + agentId + "-" + transactionId;
    const stagePath = path.join(this.workspaceRoot, stageName);
    const backupPath = path.join(this.workspaceRoot, backupName);
    const journalPath = path.join(this.recoveryRoot, transactionId + ".json");
    await mkdir(stagePath, { mode: 0o700 });
    try {
      const directories = manifest.entries
        .filter((entry): entry is Extract<SnapshotEntry, { type: "directory" }> =>
          entry.type === "directory",
        )
        .sort(
          (left, right) =>
            left.path.split("/").length - right.path.split("/").length ||
            lexicalCompare(left.path, right.path),
        );
      for (const entry of directories) {
        await mkdir(resolveInside(stagePath, entry.path), {
          recursive: false,
          mode: 0o700,
        });
      }
      for (const entry of manifest.entries) {
        if (entry.type !== "file") continue;
        await copyAndHashRegularFile(
          resolveInside(payloadRoot, entry.path),
          resolveInside(stagePath, entry.path),
          this.limits.maxFileBytes,
          entry,
        );
      }
      for (const entry of manifest.entries) {
        if (entry.type !== "symlink") continue;
        await symlink(entry.target, resolveInside(stagePath, entry.path));
      }
      for (const entry of [...directories].reverse()) {
        await chmod(resolveInside(stagePath, entry.path), entry.mode);
      }
      await chmod(stagePath, manifest.rootMode);

      const journal: RecoveryJournal = {
        version: 1,
        transactionId,
        agentId,
        runId,
        stageName,
        backupName,
      };
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if ((await pathKind(canonicalWorkspace)) !== "directory") {
        throw new RollbackSnapshotError(
          "Agent workspace is unavailable for rollback",
          "recovery_failed",
        );
      }
      await rename(canonicalWorkspace, backupPath);
      try {
        await rename(stagePath, canonicalWorkspace);
      } catch (error) {
        try {
          await rename(backupPath, canonicalWorkspace);
        } catch {
          throw new RollbackSnapshotError(
            "Workspace rollback requires startup recovery",
            "recovery_failed",
          );
        }
        throw error;
      }
      try {
        await removeTreeNoFollow(backupPath);
        await unlink(journalPath).catch(() => undefined);
      } catch {
        // Keep the journal so startup can safely recognize and remove the backup.
      }
    } catch (error) {
      if ((await pathKind(canonicalWorkspace)) === "directory") {
        await removeTreeNoFollow(stagePath).catch(() => undefined);
        if ((await pathKind(backupPath)) === "directory") {
          await removeTreeNoFollow(backupPath).catch(() => undefined);
        }
        await unlink(journalPath).catch(() => undefined);
      }
      if (error instanceof RollbackSnapshotError) throw error;
      throw new RollbackSnapshotError(
        "Workspace rollback could not be completed safely",
        "recovery_failed",
      );
    }
  }

  async remove(agentId: string, snapshotId: string): Promise<void> {
    this.assertIdentifier(agentId);
    this.assertIdentifier(snapshotId);
    await removeTreeNoFollow(path.join(this.snapshotRoot, agentId, snapshotId));
  }

  async removeAgent(agentId: string): Promise<void> {
    this.assertIdentifier(agentId);
    await removeTreeNoFollow(path.join(this.snapshotRoot, agentId));
  }

  private async canonicalWorkspace(
    agentId: string,
    workspacePath: string,
  ): Promise<string> {
    const expected = path.join(this.workspaceRoot, agentId);
    if (path.resolve(workspacePath) !== expected) {
      throw new RollbackSnapshotError(
        "Agent workspace is outside the configured workspace root",
        "snapshot_failed",
      );
    }
    const rootStats = await lstat(this.workspaceRoot);
    const workspaceStats = await lstat(expected);
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      !workspaceStats.isDirectory() ||
      workspaceStats.isSymbolicLink()
    ) {
      throw new RollbackSnapshotError(
        "Agent workspace is not a safe directory",
        "snapshot_failed",
      );
    }
    const canonicalRoot = await realpath(this.workspaceRoot);
    const canonicalWorkspace = await realpath(expected);
    if (path.dirname(canonicalWorkspace) !== canonicalRoot) {
      throw new RollbackSnapshotError(
        "Agent workspace resolved outside its configured parent",
        "snapshot_failed",
      );
    }
    return canonicalWorkspace;
  }

  private assertIdentifier(value: string): void {
    if (!identifier.safeParse(value).success) {
      throw new RollbackSnapshotError(
        "Rollback snapshot identity is invalid",
        "snapshot_corrupt",
      );
    }
  }

  private async recoverInterruptedRestores(agents: readonly Agent[]): Promise<void> {
    const knownAgents = new Map(agents.map((agent) => [agent.id, agent]));
    const journals = await readdir(this.recoveryRoot, { withFileTypes: true });
    journals.sort((left, right) => lexicalCompare(left.name, right.name));
    for (const journalEntry of journals) {
      if (!journalEntry.isFile() || !journalEntry.name.endsWith(".json")) continue;
      const journalPath = path.join(this.recoveryRoot, journalEntry.name);
      let value: unknown;
      try {
        value = await readBoundedJson(
          journalPath,
          16 * 1024,
          "recovery_failed",
        );
      } catch {
        continue;
      }
      const parsed = recoveryJournalSchema.safeParse(value);
      if (!parsed.success) continue;
      const journal = parsed.data;
      if (journalEntry.name !== journal.transactionId + ".json") continue;
      const expectedStage =
        ".ultr0n-rollback-stage-" + journal.agentId + "-" + journal.transactionId;
      const expectedBackup =
        ".ultr0n-rollback-backup-" + journal.agentId + "-" + journal.transactionId;
      if (journal.stageName !== expectedStage || journal.backupName !== expectedBackup) {
        continue;
      }
      const agent = knownAgents.get(journal.agentId);
      if (!agent) continue;
      const expectedWorkspace = path.join(this.workspaceRoot, agent.id);
      if (path.resolve(agent.workspacePath) !== expectedWorkspace) continue;
      const stagePath = path.join(this.workspaceRoot, journal.stageName);
      const backupPath = path.join(this.workspaceRoot, journal.backupName);
      let workspaceKind = await pathKind(expectedWorkspace);
      const backupKind = await pathKind(backupPath);
      const stageKind = await pathKind(stagePath);
      if (
        workspaceKind === "other" ||
        backupKind === "other" ||
        stageKind === "other"
      ) {
        throw new RollbackSnapshotError(
          "Unsafe rollback recovery artifact requires manual inspection",
          "recovery_failed",
        );
      }
      if (workspaceKind === "missing") {
        if (backupKind !== "directory") {
          throw new RollbackSnapshotError(
            "Agent workspace is missing and has no valid rollback backup",
            "recovery_failed",
          );
        }
        await rename(backupPath, expectedWorkspace);
        workspaceKind = "directory";
      }
      if (workspaceKind === "directory") {
        if ((await pathKind(stagePath)) === "directory") {
          await removeTreeNoFollow(stagePath);
        }
        if ((await pathKind(backupPath)) === "directory") {
          await removeTreeNoFollow(backupPath);
        }
        await unlink(journalPath);
      }
    }
  }
}
