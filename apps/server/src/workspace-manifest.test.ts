import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceManifest,
  compareWorkspaceManifests,
  DEFAULT_WORKSPACE_MANIFEST_LIMITS,
  type WorkspaceManifest,
} from "./workspace-manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-manifest-"));
  temporaryDirectories.push(root);
  return root;
}

function manifest(
  entries: Array<[string, string]>,
  options: Partial<WorkspaceManifest> = {},
): WorkspaceManifest {
  return {
    entries: new Map(
      entries.map(([workspacePath, digest]) => [
        workspacePath,
        { path: workspacePath, size: 1, digest },
      ]),
    ),
    skippedPaths: new Set(),
    enumerationComplete: true,
    available: true,
    capturedAt: "2026-08-30T00:00:00.000Z",
    ...options,
  };
}

describe("bounded workspace manifests", () => {
  it("reports no mutation for an unchanged regular file", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "app.ts"), "unchanged\n");
    const before = await captureWorkspaceManifest(root);
    const after = await captureWorkspaceManifest(root);
    expect(compareWorkspaceManifests(before, after)).toMatchObject({
      mutations: [],
      status: "complete",
    });
  });

  it("reports a changed file as modified", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "app.ts"), "before\n");
    const before = await captureWorkspaceManifest(root);
    await writeFile(path.join(root, "app.ts"), "after content\n");
    const after = await captureWorkspaceManifest(root);
    expect(compareWorkspaceManifests(before, after).mutations).toEqual([
      { kind: "modify", path: "app.ts" },
    ]);
  });

  it("uses the digest to detect a same-size content change", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "same-size.txt"), "AAAA");
    const before = await captureWorkspaceManifest(root);
    await writeFile(path.join(root, "same-size.txt"), "BBBB");
    const after = await captureWorkspaceManifest(root);
    expect(before.entries.get("same-size.txt")?.size).toBe(
      after.entries.get("same-size.txt")?.size,
    );
    expect(compareWorkspaceManifests(before, after).mutations).toEqual([
      { kind: "modify", path: "same-size.txt" },
    ]);
  });

  it("reports a newly created regular file", async () => {
    const root = await workspace();
    const before = await captureWorkspaceManifest(root);
    await writeFile(path.join(root, "created.txt"), "created\n");
    const after = await captureWorkspaceManifest(root);
    expect(compareWorkspaceManifests(before, after).mutations).toEqual([
      { kind: "create", path: "created.txt" },
    ]);
  });

  it("reports a removed regular file", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "deleted.txt"), "deleted\n");
    const before = await captureWorkspaceManifest(root);
    await unlink(path.join(root, "deleted.txt"));
    const after = await captureWorkspaceManifest(root);
    expect(compareWorkspaceManifests(before, after).mutations).toEqual([
      { kind: "delete", path: "deleted.txt" },
    ]);
  });

  it("sorts and reports multiple net mutations", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "modify.txt"), "old\n");
    await writeFile(path.join(root, "remove.txt"), "remove\n");
    const before = await captureWorkspaceManifest(root);
    await writeFile(path.join(root, "add.txt"), "add\n");
    await writeFile(path.join(root, "modify.txt"), "new\n");
    await unlink(path.join(root, "remove.txt"));
    const after = await captureWorkspaceManifest(root);
    expect(compareWorkspaceManifests(before, after).mutations).toEqual([
      { kind: "create", path: "add.txt" },
      { kind: "modify", path: "modify.txt" },
      { kind: "delete", path: "remove.txt" },
    ]);
  });

  it("does not follow file or directory symlinks", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, "outside.txt"), "outside\n");
    await mkdir(path.join(root, "inside"));
    await symlink(path.join(outside, "outside.txt"), path.join(root, "file-link"));
    await symlink(outside, path.join(root, "directory-link"));
    const captured = await captureWorkspaceManifest(root);
    expect([...captured.entries.keys()]).toEqual([]);
    expect(JSON.stringify([...captured.entries.values()])).not.toContain("outside");
  });

  it("cannot traverse a workspace symlink into an external tree", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(path.join(outside, "nested"));
    await writeFile(path.join(outside, "nested", "escaped.txt"), "escaped\n");
    await symlink(path.join(outside, "nested"), path.join(root, "escape"));
    const captured = await captureWorkspaceManifest(root);
    expect(captured.entries.has("escape/escaped.txt")).toBe(false);
    expect([...captured.entries.keys()].every((entry) => !entry.includes(".."))).toBe(
      true,
    );
  });

  it("skips oversized paths and never converts skipped evidence into a create", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "bounded.txt"), "TOO LARGE");
    const limits = { ...DEFAULT_WORKSPACE_MANIFEST_LIMITS, maxFileBytes: 4 };
    const before = await captureWorkspaceManifest(root, limits);
    await writeFile(path.join(root, "bounded.txt"), "OK");
    const after = await captureWorkspaceManifest(root, limits);
    expect(before.skippedPaths).toEqual(new Set(["bounded.txt"]));
    expect(compareWorkspaceManifests(before, after)).toMatchObject({
      mutations: [],
      status: "partial",
    });
  });

  it("applies conservative absence rules to incomplete enumeration", () => {
    const incompleteBefore = manifest([], { enumerationComplete: false });
    const incompleteAfter = manifest([], { enumerationComplete: false });
    expect(
      compareWorkspaceManifests(incompleteBefore, manifest([["new.txt", "new"]]))
        .mutations,
    ).toEqual([]);
    expect(
      compareWorkspaceManifests(manifest([["old.txt", "old"]]), incompleteAfter)
        .mutations,
    ).toEqual([]);
    expect(
      compareWorkspaceManifests(
        manifest([["same.txt", "before"]], { enumerationComplete: false }),
        manifest([["same.txt", "after"]], { enumerationComplete: false }),
      ).mutations,
    ).toEqual([{ kind: "modify", path: "same.txt" }]);

    expect(
      compareWorkspaceManifests(
        manifest([["unhashable.txt", "before"]]),
        manifest([], { skippedPaths: new Set(["unhashable.txt"]) }),
      ).mutations,
    ).toEqual([]);
    expect(
      compareWorkspaceManifests(
        manifest([], { skippedPaths: new Set(["unhashable.txt"]) }),
        manifest([["unhashable.txt", "after"]]),
      ).mutations,
    ).toEqual([]);
  });

  it("reports only net resulting state after content is restored", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "restored.txt"), "ORIGINAL\n");
    const original = await readFile(path.join(root, "restored.txt"), "utf8");
    const before = await captureWorkspaceManifest(root);
    await writeFile(path.join(root, "restored.txt"), "TRANSIENT\n");
    await writeFile(path.join(root, "restored.txt"), original);
    const after = await captureWorkspaceManifest(root);
    expect(compareWorkspaceManifests(before, after).mutations).toEqual([]);
  });
});
