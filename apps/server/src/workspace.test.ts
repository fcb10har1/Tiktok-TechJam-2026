import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkspaceManager.readInventory", () => {
  it("returns a bounded relative inventory without ignored trees or symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-inventory-test-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "agent");
    await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules", "package"), { recursive: true });
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(workspace, ".env"), "SECRET=test\n");
    await writeFile(path.join(workspace, "src", "index.ts"), "export {};\n");
    await writeFile(path.join(workspace, "src", "nested", "test.ts"), "export {};\n");
    await writeFile(path.join(workspace, "node_modules", "package", "index.js"), "");
    await writeFile(path.join(workspace, ".git", "config"), "");
    await symlink(path.join(root, "outside"), path.join(workspace, "external"));

    const manager = new WorkspaceManager(root);
    const inventory = await manager.readInventory(workspace);

    expect(inventory).toEqual([
      ".env",
      "src/",
      "src/index.ts",
      "src/nested/",
      "src/nested/test.ts",
    ]);
    expect(inventory.every((entry) => !path.isAbsolute(entry))).toBe(true);
  });
});
