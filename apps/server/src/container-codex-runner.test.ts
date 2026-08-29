import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  buildWorkspaceMountArgs,
  containerName,
} from "./container-codex-runner.js";
import type { RunnerRequest, WorkspaceAuthorityPlan } from "./types.js";
import { prepareWorkspaceAuthority } from "./workspace-authority.js";

describe("Container Codex runner", () => {
  const temporaryPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryPaths.splice(0).map((temporaryPath) =>
        rm(temporaryPath, { recursive: true, force: true }),
      ),
    );
  });

  const request = (
    workspacePath: string,
    authorityPlan: WorkspaceAuthorityPlan,
    overrides: Partial<RunnerRequest> = {},
  ): RunnerRequest => ({
    agentId: "agent",
    workspacePath,
    prompt: "test",
    threadId: null,
    writablePaths: [],
    protectedPaths: [],
    authorityPlan,
    ...overrides,
  });

  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const authorityPlan: WorkspaceAuthorityPlan = {
      workspaceSourcePath: "/tmp/agent-workspace",
      writableMounts: [],
      protectedMounts: [],
    };
    const args = buildContainerRunArgs(
      request("/tmp/agent-workspace", authorityPlan, {
        agentId: "agent/unsafe",
        prompt: "write a small program",
      }),
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain(
      "type=bind,src=/tmp/agent-workspace,dst=/workspace,readonly,bind-nonrecursive",
    );
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      request(
        "/tmp/workspace",
        {
          workspaceSourcePath: "/tmp/workspace",
          writableMounts: [],
          protectedMounts: [],
        },
        { prompt: "continue", threadId: "thread-123" },
      ),
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });

  it("orders a read-only root, writable exceptions, then protected overrides", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "authority-mounts-"));
    temporaryPaths.push(workspacePath);
    await mkdir(path.join(workspacePath, "src"));
    await mkdir(path.join(workspacePath, "src", "secrets"));
    await writeFile(path.join(workspacePath, "src", "app.ts"), "app\n");
    await writeFile(path.join(workspacePath, "src", "secrets", "key"), "secret\n");
    await writeFile(path.join(workspacePath, "package.json"), "{}\n");
    await writeFile(path.join(workspacePath, ".env"), "SECRET=original\n");
    const authority = prepareWorkspaceAuthority({
      workspacePath,
      writablePaths: ["src/**", "package.json"],
      protectedPaths: [".env", "src/secrets/**"],
    });
    const canonicalWorkspace = await realpath(workspacePath);

    expect(
      buildWorkspaceMountArgs(
        request(workspacePath, authority.plan, {
          writablePaths: authority.writablePaths,
          protectedPaths: authority.protectedPaths,
        }),
        "docker",
      ),
    ).toEqual([
      "--mount",
      "type=bind,src=" +
        canonicalWorkspace +
        ",dst=/workspace,readonly,bind-recursive=disabled",
      "--mount",
      "type=bind,src=" +
        canonicalWorkspace +
        "/src,dst=/workspace/src,bind-recursive=disabled",
      "--mount",
      "type=bind,src=" +
        canonicalWorkspace +
        "/package.json,dst=/workspace/package.json",
      "--mount",
      "type=bind,src=" + canonicalWorkspace + "/.env,dst=/workspace/.env,readonly",
      "--mount",
      "type=bind,src=" +
        canonicalWorkspace +
        "/src/secrets,dst=/workspace/src/secrets,readonly,bind-recursive=disabled",
    ]);
  });
});
