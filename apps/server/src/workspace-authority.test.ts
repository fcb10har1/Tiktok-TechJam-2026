import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileWorkspaceAuthority,
  prepareWorkspaceAuthority,
  validateWorkspaceAuthorityDraft,
} from "./workspace-authority.js";

describe("WorkspaceAuthority", () => {
  const temporaryPaths: string[] = [];

  const workspace = async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "authority-test-"));
    temporaryPaths.push(workspacePath);
    return workspacePath;
  };

  afterEach(async () => {
    await Promise.all(
      temporaryPaths.splice(0).map((temporaryPath) =>
        rm(temporaryPath, { recursive: true, force: true }),
      ),
    );
  });

  it("prepares only explicitly approved greenfield roots and exact files", async () => {
    const workspacePath = await workspace();

    const authority = prepareWorkspaceAuthority({
      workspacePath,
      writablePaths: ["src/**", "tests/**", "public/**", "package.json"],
      protectedPaths: [".env", "deployment/**"],
    });

    expect(authority.preparations).toEqual([
      { path: "src", kind: "directory", purpose: "writable", existedBeforeRun: false },
      {
        path: "tests",
        kind: "directory",
        purpose: "writable",
        existedBeforeRun: false,
      },
      {
        path: "public",
        kind: "directory",
        purpose: "writable",
        existedBeforeRun: false,
      },
      {
        path: "package.json",
        kind: "file",
        purpose: "writable",
        existedBeforeRun: false,
      },
    ]);
    expect(authority.plan.writableMounts.map((mount) => mount.path)).toEqual([
      "src",
      "tests",
      "public",
      "package.json",
    ]);
    expect(authority.plan.protectedMounts).toEqual([]);
    await expect(readFile(path.join(workspacePath, "package.json"), "utf8")).resolves
      .toBe("");
    await expect(readFile(path.join(workspacePath, ".env"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("prepares missing protected children inside writable authority", async () => {
    const workspacePath = await workspace();
    await mkdir(path.join(workspacePath, "src"));

    const authority = prepareWorkspaceAuthority({
      workspacePath,
      writablePaths: ["src/**"],
      protectedPaths: ["src/secrets/**", "src/token.txt"],
    });

    expect(authority.preparations).toEqual([
      {
        path: "src/secrets",
        kind: "directory",
        purpose: "protected",
        existedBeforeRun: false,
      },
      {
        path: "src/token.txt",
        kind: "file",
        purpose: "protected",
        existedBeforeRun: false,
      },
    ]);
    expect(authority.plan.protectedMounts.map((mount) => mount.path)).toEqual([
      "src/secrets",
      "src/token.txt",
    ]);
  });

  it("lets a protected parent defeat a writable child", async () => {
    const workspacePath = await workspace();
    await mkdir(path.join(workspacePath, "deployment"));
    await writeFile(path.join(workspacePath, "deployment", "config.yml"), "safe\n");

    const authority = prepareWorkspaceAuthority({
      workspacePath,
      writablePaths: ["deployment/config.yml"],
      protectedPaths: ["deployment/**"],
    });

    expect(authority.plan.writableMounts).toEqual([]);
    expect(authority.plan.protectedMounts.map((mount) => mount.path)).toEqual([
      "deployment",
    ]);
  });

  it("rejects declared symlink roots and pre-existing hard-link aliases", async () => {
    const workspacePath = await workspace();
    const outsidePath = workspacePath + "-outside";
    temporaryPaths.push(outsidePath);
    await writeFile(outsidePath, "outside\n");
    await symlink(outsidePath, path.join(workspacePath, "escape"));

    expect(() =>
      prepareWorkspaceAuthority({
        workspacePath,
        writablePaths: ["escape"],
        protectedPaths: [],
      }),
    ).toThrow("symbolic link");

    await mkdir(path.join(workspacePath, "src"));
    await writeFile(path.join(workspacePath, "README.md"), "original\n");
    await link(
      path.join(workspacePath, "README.md"),
      path.join(workspacePath, "src", "alias.md"),
    );
    expect(() =>
      prepareWorkspaceAuthority({
        workspacePath,
        writablePaths: ["src/**"],
        protectedPaths: [],
      }),
    ).toThrow("hard-linked file");
  });

  it("compilation never prepares a missing target", async () => {
    const workspacePath = await workspace();
    expect(() =>
      compileWorkspaceAuthority({
        workspacePath,
        writablePaths: ["src/**"],
        protectedPaths: [],
      }),
    ).toThrow("Approved writable target does not exist");
  });

  it("validates a draft without preparing its missing authority targets", async () => {
    const workspacePath = await workspace();

    expect(
      validateWorkspaceAuthorityDraft({
        workspacePath,
        writablePaths: ["src/**", "package.json"],
        protectedPaths: [".env", "deployment/**"],
      }),
    ).toEqual({
      writablePaths: ["src/**", "package.json"],
      protectedPaths: [".env", "deployment/**"],
    });
    await expect(readFile(path.join(workspacePath, "package.json"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(workspacePath, ".env"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink target during draft validation", async () => {
    const workspacePath = await workspace();
    const outsidePath = workspacePath + "-outside";
    temporaryPaths.push(outsidePath);
    await writeFile(outsidePath, "outside\n");
    await symlink(outsidePath, path.join(workspacePath, "escape"));

    expect(() =>
      validateWorkspaceAuthorityDraft({
        workspacePath,
        writablePaths: ["escape"],
        protectedPaths: [],
      }),
    ).toThrow("symbolic link");
  });
});
