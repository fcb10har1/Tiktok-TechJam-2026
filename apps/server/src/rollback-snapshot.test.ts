import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ROLLBACK_SNAPSHOT_LIMITS,
  RollbackSnapshotManager,
} from "./rollback-snapshot.js";
import type { Agent } from "./types.js";

const agentId = "agent-1";
const runId = "run-1";
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
let root: string;
let dataRoot: string;
let workspaceRoot: string;
let workspacePath: string;
let agent: Agent;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rollback-snapshot-test-"));
  temporaryDirectories.push(root);
  dataRoot = path.join(root, "data");
  workspaceRoot = path.join(root, "workspaces");
  workspacePath = path.join(workspaceRoot, agentId);
  await mkdir(workspacePath, { recursive: true });
  agent = {
    id: agentId,
    name: "Snapshot test",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function manager() {
  const snapshots = new RollbackSnapshotManager(dataRoot, workspaceRoot);
  await snapshots.initialize([agent]);
  return snapshots;
}

async function exists(targetPath: string): Promise<boolean> {
  return lstat(targetPath).then(
    () => true,
    () => false,
  );
}

describe("RollbackSnapshotManager", () => {
  it("restores modified content exactly, including a same-size change", async () => {
    await mkdir(path.join(workspacePath, "src"));
    const filePath = path.join(workspacePath, "src", "auth.ts");
    await writeFile(filePath, "ORIGINAL");
    const snapshots = await manager();
    const snapshot = await snapshots.create(agentId, runId, workspacePath);
    await writeFile(filePath, "MUTATED!");

    await snapshots.restore(agentId, runId, snapshot.snapshotId, workspacePath);

    expect(await readFile(filePath, "utf8")).toBe("ORIGINAL");
  });

  it("removes created files and nested directories", async () => {
    await writeFile(path.join(workspacePath, "existing.txt"), "before");
    const snapshots = await manager();
    const snapshot = await snapshots.create(agentId, runId, workspacePath);
    await mkdir(path.join(workspacePath, "new", "nested"), { recursive: true });
    await writeFile(path.join(workspacePath, "new", "nested", "created.ts"), "new");

    await snapshots.restore(agentId, runId, snapshot.snapshotId, workspacePath);

    expect(await exists(path.join(workspacePath, "new"))).toBe(false);
    expect(await readFile(path.join(workspacePath, "existing.txt"), "utf8")).toBe(
      "before",
    );
  });

  it("restores deleted files, empty directories, and multiple changes together", async () => {
    await mkdir(path.join(workspacePath, "empty"));
    await mkdir(path.join(workspacePath, "src"));
    await writeFile(path.join(workspacePath, "src", "one.ts"), "one-before");
    await writeFile(path.join(workspacePath, "src", "two.ts"), "two-before");
    const snapshots = await manager();
    const snapshot = await snapshots.create(agentId, runId, workspacePath);
    await writeFile(path.join(workspacePath, "src", "one.ts"), "one-after");
    await rm(path.join(workspacePath, "src", "two.ts"));
    await rm(path.join(workspacePath, "empty"), { recursive: true });
    await writeFile(path.join(workspacePath, "created.ts"), "created");

    await snapshots.restore(agentId, runId, snapshot.snapshotId, workspacePath);

    expect(await readFile(path.join(workspacePath, "src", "one.ts"), "utf8")).toBe(
      "one-before",
    );
    expect(await readFile(path.join(workspacePath, "src", "two.ts"), "utf8")).toBe(
      "two-before",
    );
    expect((await lstat(path.join(workspacePath, "empty"))).isDirectory()).toBe(true);
    expect(await exists(path.join(workspacePath, "created.ts"))).toBe(false);
  });

  it("preserves symlinks without reading or changing an external target", async () => {
    const external = path.join(root, "outside-secret.txt");
    await writeFile(external, "DO NOT COPY OR CHANGE");
    await symlink(external, path.join(workspacePath, "external-link"));
    const snapshots = await manager();
    const snapshot = await snapshots.create(agentId, runId, workspacePath);
    await rm(path.join(workspacePath, "external-link"));
    await writeFile(path.join(workspacePath, "external-link"), "replacement");

    await snapshots.restore(agentId, runId, snapshot.snapshotId, workspacePath);

    expect(await readlink(path.join(workspacePath, "external-link"))).toBe(external);
    expect(await readFile(external, "utf8")).toBe("DO NOT COPY OR CHANGE");
  });

  it("rejects special files instead of claiming a complete snapshot", async () => {
    const fifoPath = path.join(workspacePath, "agent.fifo");
    await execFileAsync("mkfifo", [fifoPath]);
    const snapshots = await manager();

    await expect(snapshots.create(agentId, runId, workspacePath)).rejects.toMatchObject({
      code: "snapshot_failed",
    });
  });

  it("fails safely when snapshot byte bounds are exceeded", async () => {
    await writeFile(path.join(workspacePath, "large.txt"), "12345");
    const snapshots = new RollbackSnapshotManager(dataRoot, workspaceRoot, {
      ...DEFAULT_ROLLBACK_SNAPSHOT_LIMITS,
      maxFileBytes: 4,
      maxTotalBytes: 4,
    });
    await snapshots.initialize([agent]);

    await expect(snapshots.create(agentId, runId, workspacePath)).rejects.toMatchObject({
      code: "snapshot_failed",
    });
  });

  it("rejects corrupt payloads before replacing the current workspace", async () => {
    await writeFile(path.join(workspacePath, "safe.txt"), "original");
    const snapshots = await manager();
    const snapshot = await snapshots.create(agentId, runId, workspacePath);
    await writeFile(
      path.join(dataRoot, "rollback-snapshots", agentId, runId, "files", "safe.txt"),
      "corrupt!",
    );
    await writeFile(path.join(workspacePath, "safe.txt"), "current");

    await expect(
      snapshots.restore(agentId, runId, snapshot.snapshotId, workspacePath),
    ).rejects.toMatchObject({ code: "snapshot_corrupt" });
    expect(await readFile(path.join(workspacePath, "safe.txt"), "utf8")).toBe(
      "current",
    );
  });

  it("rejects manifest traversal without touching files outside the workspace", async () => {
    await writeFile(path.join(workspacePath, "safe.txt"), "original");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside");
    const snapshots = await manager();
    await snapshots.create(agentId, runId, workspacePath);
    const manifestPath = path.join(
      dataRoot,
      "rollback-snapshots",
      agentId,
      runId,
      "snapshot.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries[0].path = "../outside.txt";
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(
      snapshots.restore(agentId, runId, runId, workspacePath),
    ).rejects.toMatchObject({ code: "snapshot_corrupt" });
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("recovers the backup when a crash leaves the canonical workspace missing", async () => {
    await writeFile(path.join(workspacePath, "state.txt"), "recover me");
    const snapshots = await manager();
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const stageName = `.ultr0n-rollback-stage-${agentId}-${transactionId}`;
    const backupName = `.ultr0n-rollback-backup-${agentId}-${transactionId}`;
    await mkdir(path.join(workspaceRoot, stageName));
    await writeFile(path.join(workspaceRoot, stageName, "state.txt"), "restored state");
    await rename(workspacePath, path.join(workspaceRoot, backupName));
    await writeFile(
      path.join(dataRoot, "rollback-snapshots", ".recovery", transactionId + ".json"),
      JSON.stringify({
        version: 1,
        transactionId,
        agentId,
        runId,
        stageName,
        backupName,
      }),
    );

    await snapshots.initialize([agent]);

    expect(await readFile(path.join(workspacePath, "state.txt"), "utf8")).toBe(
      "recover me",
    );
    expect(await exists(path.join(workspaceRoot, stageName))).toBe(false);
  });

  it("never overwrites a canonical workspace because a stale backup exists", async () => {
    await writeFile(path.join(workspacePath, "state.txt"), "canonical");
    const snapshots = await manager();
    const transactionId = "22222222-2222-4222-8222-222222222222";
    const stageName = `.ultr0n-rollback-stage-${agentId}-${transactionId}`;
    const backupName = `.ultr0n-rollback-backup-${agentId}-${transactionId}`;
    await mkdir(path.join(workspaceRoot, stageName));
    await mkdir(path.join(workspaceRoot, backupName));
    await writeFile(path.join(workspaceRoot, backupName, "state.txt"), "stale backup");
    await writeFile(
      path.join(dataRoot, "rollback-snapshots", ".recovery", transactionId + ".json"),
      JSON.stringify({
        version: 1,
        transactionId,
        agentId,
        runId,
        stageName,
        backupName,
      }),
    );

    await snapshots.initialize([agent]);

    expect(await readFile(path.join(workspacePath, "state.txt"), "utf8")).toBe(
      "canonical",
    );
    expect(await exists(path.join(workspaceRoot, stageName))).toBe(false);
    expect(await exists(path.join(workspaceRoot, backupName))).toBe(false);
  });

  it("never deletes staging when it is the only possible workspace copy", async () => {
    const snapshots = await manager();
    const transactionId = "33333333-3333-4333-8333-333333333333";
    const stageName = `.ultr0n-rollback-stage-${agentId}-${transactionId}`;
    const backupName = `.ultr0n-rollback-backup-${agentId}-${transactionId}`;
    const stagePath = path.join(workspaceRoot, stageName);
    await mkdir(stagePath);
    await writeFile(path.join(stagePath, "state.txt"), "only possible copy");
    await rm(workspacePath, { recursive: true });
    await writeFile(
      path.join(dataRoot, "rollback-snapshots", ".recovery", transactionId + ".json"),
      JSON.stringify({
        version: 1,
        transactionId,
        agentId,
        runId,
        stageName,
        backupName,
      }),
    );

    await expect(snapshots.initialize([agent])).rejects.toMatchObject({
      code: "recovery_failed",
    });
    expect(await readFile(path.join(stagePath, "state.txt"), "utf8")).toBe(
      "only possible copy",
    );
  });
});
