import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  buildWorkspaceMountArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  const temporaryPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryPaths.splice(0).map((temporaryPath) =>
        rm(temporaryPath, { recursive: true, force: true }),
      ),
    );
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
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
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
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });

  it("overlays existing protected paths with read-only bind mounts", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "agentguard-mounts-"));
    temporaryPaths.push(workspacePath);
    await mkdir(path.join(workspacePath, "deployment"));
    await writeFile(path.join(workspacePath, ".env"), "SECRET_VALUE=ORIGINAL\n");
    await writeFile(
      path.join(workspacePath, "deployment", "config.yml"),
      "environment: production\n",
    );

    const canonicalWorkspace = await realpath(workspacePath);
    expect(
      buildWorkspaceMountArgs({
        agentId: "agent",
        workspacePath,
        prompt: "test",
        threadId: null,
      }),
    ).toEqual([
      "--mount",
      "type=bind,src=" + workspacePath + ",dst=/workspace",
      "--mount",
      "type=bind,src=" + canonicalWorkspace + "/.env,dst=/workspace/.env,readonly",
      "--mount",
      "type=bind,src=" +
        canonicalWorkspace +
        "/deployment,dst=/workspace/deployment,readonly",
    ]);
  });

  it("rejects protected path traversal and symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentguard-validation-"));
    temporaryPaths.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    await writeFile(path.join(root, "outside"), "outside\n");
    await symlink(path.join(root, "outside"), path.join(workspacePath, "escape"));
    const request = {
      agentId: "agent",
      workspacePath,
      prompt: "test",
      threadId: null,
    };

    expect(() =>
      buildWorkspaceMountArgs({ ...request, protectedPaths: ["../outside"] }),
    ).toThrow("Protected path escapes the workspace");
    expect(() =>
      buildWorkspaceMountArgs({ ...request, protectedPaths: ["escape"] }),
    ).toThrow("Protected path resolves outside the workspace");
  });
});
