import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, type PlannerDiagnostic } from "./agent-service.js";
import { loadConfig } from "./config.js";
import type {
  ContractAmendment,
  ContractAmendmentInput,
  ContractPlanner,
  ContractPlanningInput,
  ContractProposal,
} from "./contract-planner.js";
import { ContractPlanningError } from "./contract-planner.js";
import { RunExecutionError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunEvent, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  readonly calls: RunnerRequest[] = [];

  constructor(private readonly events: RunEvent[] = []) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(structuredClone(request));
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
      events: structuredClone(this.events),
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const basicProposal: ContractProposal = {
  goal: "Complete the requested task",
  plannedActions: ["Inspect the relevant files", "Make the requested change", "Run tests"],
  writablePaths: ["src/**"],
  protectedPaths: [],
  riskLevel: "low",
  rationale: "The proposed change is limited to source files.",
};

class FakePlanner implements ContractPlanner {
  readonly calls: ContractPlanningInput[] = [];
  readonly amendmentCalls: ContractAmendmentInput[] = [];

  constructor(
    private readonly result:
      | ContractProposal
      | Error
      | Array<ContractProposal | Error> = basicProposal,
    private readonly amendmentResults: Array<ContractAmendment | Error> = [],
  ) {}

  async propose(input: ContractPlanningInput): Promise<ContractProposal> {
    this.calls.push(structuredClone(input));
    const result = Array.isArray(this.result) ? this.result.shift() : this.result;
    if (!result) throw new Error("No fake proposal was configured");
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }

  async amend(input: ContractAmendmentInput): Promise<ContractAmendment> {
    this.amendmentCalls.push(structuredClone(input));
    const result = this.amendmentResults.shift();
    if (!result) throw new Error("No fake amendment was configured");
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  environment: NodeJS.ProcessEnv = {},
  planner: ContractPlanner = new FakePlanner(),
  diagnosticLogger: (diagnostic: PlannerDiagnostic) => void = () => undefined,
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    planner,
    diagnosticLogger,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation after approval", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");

    expect(run.status).toBe("awaiting_approval");
    expect(run.executionContract).toMatchObject({
      version: 1,
      proposalSource: "ai",
      goal: "Complete the requested task",
      writablePaths: ["src/**"],
      riskLevel: "low",
    });
    expect(run.executionContract?.protectedPaths).toEqual([".env", "deployment"]);
    expect(runner.calls).toHaveLength(0);

    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(runner.calls[0]?.writablePaths).toEqual(["src/**"]);
    expect(runner.calls[0]?.authorityPlan.writableMounts.map((mount) => mount.path))
      .toEqual(["src"]);
    expect(service.getRun(run.id).authorityPreparations).toEqual([
      {
        path: "src",
        kind: "directory",
        purpose: "writable",
        existedBeforeRun: false,
      },
    ]);
  });

  it("persists deterministic runner evidence without changing approved authority", async () => {
    const runner = new FakeRunner([
      {
        id: "codex-item-1",
        sequence: 1,
        timestamp: "2026-08-30T00:00:00.000Z",
        kind: "command",
        outcome: "success",
        technical: {
          source: "codex-jsonl",
          itemType: "command_execution",
          itemId: "item-1",
          exitCode: 0,
        },
      },
    ]);
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Observable" });
    const { run } = await service.sendMessage(agent.id, "change the app");
    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).events).toEqual([
      expect.objectContaining({ kind: "command" }),
    ]);
    expect(runner.calls[0]).toMatchObject({
      writablePaths: ["src/**"],
      protectedPaths: [".env", "deployment"],
    });
  });

  it("persists a successful resulting workspace modification from PRE and POST", async () => {
    const calls: RunnerRequest[] = [];
    const runner: AgentRunner = {
      async run(request) {
        calls.push(structuredClone(request));
        await writeFile(
          path.join(request.workspacePath, "src", "auth.ts"),
          "// OBSERVABILITY TEST\n",
        );
        return {
          output: "Done",
          threadId: "workspace-diff-thread",
          usage: null,
          events: [],
        };
      },
      async cancel() {
        return false;
      },
      async isAvailable() {
        return true;
      },
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Successful mutation" });
    await mkdir(path.join(agent.workspacePath, "src"));
    await writeFile(path.join(agent.workspacePath, "src", "auth.ts"), "ORIGINAL\n");
    const { run } = await service.sendMessage(agent.id, "change auth");
    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id)).toMatchObject({
      workspaceDiffStatus: "complete",
      events: [
        {
          kind: "modify",
          path: "src/auth.ts",
          technical: {
            source: "workspace-diff",
            itemType: "workspace_manifest",
          },
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      writablePaths: ["src/**"],
      protectedPaths: [".env", "deployment"],
    });
  });

  it("persists evidence carried by a failed runner", async () => {
    const runner: AgentRunner = {
      async run() {
        throw new RunExecutionError("Runtime failed", [
          {
            id: "codex-blocked",
            sequence: 1,
            timestamp: "2026-08-30T00:00:00.000Z",
            kind: "blocked",
            outcome: "blocked",
            path: ".env",
            authorityReason: "explicitly_protected",
            technical: {
              source: "codex-jsonl",
              itemType: "command_execution",
              exitCode: 1,
            },
          },
        ]);
      },
      async cancel() {
        return false;
      },
      async isAvailable() {
        return true;
      },
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Failed observable" });
    const { run } = await service.sendMessage(agent.id, "try a protected write");
    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).events).toEqual([
      expect.objectContaining({
        kind: "blocked",
        authorityReason: "explicitly_protected",
      }),
    ]);
  });

  it("persists workspace-diff mutations made before a later runner failure", async () => {
    const runner: AgentRunner = {
      async run(request) {
        await writeFile(path.join(request.workspacePath, "src", "auth.ts"), "AFTER\n");
        throw new RunExecutionError("Runtime failed", [
          {
            id: "codex-blocked",
            sequence: 1,
            timestamp: "2026-08-30T00:00:00.000Z",
            kind: "blocked",
            outcome: "blocked",
            path: ".env",
            authorityReason: "explicitly_protected",
            technical: {
              source: "codex-jsonl",
              itemType: "command_execution",
              exitCode: 1,
            },
          },
        ]);
      },
      async cancel() {
        return false;
      },
      async isAvailable() {
        return true;
      },
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Failed mutation" });
    await mkdir(path.join(agent.workspacePath, "src"));
    await writeFile(path.join(agent.workspacePath, "src", "auth.ts"), "BEFORE\n");
    const { run } = await service.sendMessage(agent.id, "change auth then fail");
    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    expect(service.getRun(run.id)).toMatchObject({
      workspaceDiffStatus: "complete",
      events: [
        {
          kind: "modify",
          path: "src/auth.ts",
          technical: { source: "workspace-diff" },
        },
        {
          kind: "blocked",
          path: ".env",
          technical: { source: "codex-jsonl" },
        },
      ],
    });
  });

  it("captures PRE after authority placeholders so they are not Agent creations", async () => {
    const planner = new FakePlanner({
      goal: "Use prepared authority",
      plannedActions: ["Inspect prepared targets"],
      writablePaths: ["src/**"],
      protectedPaths: ["src/secrets.ts"],
      riskLevel: "low",
      rationale: null,
    });
    const service = await makeService(new FakeRunner(), {}, planner);
    const agent = await service.createAgent({ name: "Prepared evidence" });
    const { run } = await service.sendMessage(agent.id, "inspect placeholders");
    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const completed = service.getRun(run.id);
    expect(completed.authorityPreparations).toEqual([
      {
        path: "src",
        kind: "directory",
        purpose: "writable",
        existedBeforeRun: false,
      },
      {
        path: "src/secrets.ts",
        kind: "file",
        purpose: "protected",
        existedBeforeRun: false,
      },
    ]);
    expect(completed.events?.filter((event) => event.kind === "create")).toEqual([]);
    expect(completed.workspaceDiffStatus).toBe("complete");
  });

  it("triggers preflight planning and persists a validated AI proposal", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner({
      goal: "Add a focused utility",
      plannedActions: ["Inspect src", "Add the utility", "Test it"],
      writablePaths: ["src/utility.ts", "src/utility.test.ts"],
      protectedPaths: ["secrets"],
      riskLevel: "medium",
      rationale: "Two source files are expected to change.",
    });
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({
      name: "Planner",
      instructions: "Prefer small TypeScript changes.",
    });

    const { run } = await service.sendMessage(agent.id, "Add a utility");

    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]).toMatchObject({
      task: "Add a utility",
      agentInstructions: "Prefer small TypeScript changes.",
    });
    expect(planner.calls[0]?.workspaceInventory).toEqual(
      expect.arrayContaining(["AGENTS.md", "README.md"]),
    );
    expect(run).toMatchObject({
      status: "awaiting_approval",
      executionContract: {
        version: 1,
        goal: "Add a focused utility",
        plannedActions: ["Inspect src", "Add the utility", "Test it"],
        writablePaths: ["src/utility.ts", "src/utility.test.ts"],
        protectedPaths: [".env", "deployment", "secrets"],
        riskLevel: "medium",
        rationale: "Two source files are expected to change.",
        proposalSource: "ai",
        proposalNotice: null,
        approvedAt: null,
      },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("persists a fallback V1 contract and never runs when planning fails", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner(new Error("provider returned 429"));
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Fallback" });

    const { run } = await service.sendMessage(agent.id, "Review manually");

    expect(planner.calls).toHaveLength(1);
    expect(run).toMatchObject({
      status: "awaiting_approval",
      executionContract: {
        version: 1,
        goal: "Review manually",
        writablePaths: [],
        protectedPaths: [".env", "deployment"],
        riskLevel: "medium",
        proposalSource: "fallback",
        proposalNotice:
          "AI proposal unavailable: the provider request failed. Configure authority manually or retry AI proposal.",
        approvedAt: null,
      },
    });
    expect(service.getRun(run.id)).toEqual(run);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.calls).toHaveLength(0);
    await service.cancelRun(run.id);
  });

  it("retries a fallback proposal without executing and preserves human protections", async () => {
    const runner = new FakeRunner();
    const diagnostics: PlannerDiagnostic[] = [];
    const planner = new FakePlanner([
      new ContractPlanningError(
        "Planner is temporarily rate limited",
        "rate_limited",
        429,
      ),
      {
        ...basicProposal,
        writablePaths: ["src/**"],
        protectedPaths: ["secrets/**"],
      },
    ]);
    const service = await makeService(runner, {}, planner, (diagnostic) =>
      diagnostics.push(diagnostic),
    );
    const agent = await service.createAgent({ name: "Retry proposal" });
    const { run } = await service.sendMessage(agent.id, "Update source");
    await service.updateExecutionContract(run.id, {
      protectedPaths: [
        ...(run.executionContract?.protectedPaths ?? []),
        "package.json",
      ],
    });

    const result = await service.retryExecutionContractProposal(run.id);

    expect(result).toMatchObject({
      applied: true,
      notice: null,
      failureCode: null,
      run: {
        status: "awaiting_approval",
        executionContract: {
          proposalSource: "ai",
          writablePaths: ["src/**"],
          protectedPaths: [".env", "deployment", "package.json", "secrets/**"],
          proposalNotice: null,
          approvedAt: null,
        },
      },
    });
    expect(planner.calls).toHaveLength(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        operation: "proposal",
        code: "rate_limited",
        status: 429,
      }),
    ]);
    expect(runner.calls).toHaveLength(0);
    await service.cancelRun(run.id);
  });

  it("includes sanitized schema issues in planner diagnostics", async () => {
    const runner = new FakeRunner();
    const diagnostics: PlannerDiagnostic[] = [];
    const planner = new FakePlanner([
      new ContractPlanningError(
        "Planner returned an invalid contract schema",
        "schema_invalid",
        null,
        [
          {
            path: "riskLevel",
            code: "invalid_value",
            expected: "low|medium|high",
          },
        ],
      ),
    ]);
    const service = await makeService(runner, {}, planner, (diagnostic) =>
      diagnostics.push(diagnostic),
    );
    const agent = await service.createAgent({ name: "Schema diagnostic" });

    const { run } = await service.sendMessage(agent.id, "Update source");

    expect(diagnostics).toEqual([
      expect.objectContaining({
        operation: "proposal",
        code: "schema_invalid",
        schemaIssues: [
          {
            path: "riskLevel",
            code: "invalid_value",
            expected: "low|medium|high",
          },
        ],
      }),
    ]);
    expect(runner.calls).toHaveLength(0);
    await service.cancelRun(run.id);
  });

  it("keeps a failed retry byte-for-byte unchanged and returns a safe notice", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner([
      new ContractPlanningError("Rate limited", "rate_limited", 429),
      new ContractPlanningError("Raw secret provider message", "rate_limited", 429),
    ]);
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Preserved retry" });
    const { run } = await service.sendMessage(agent.id, "Update source");
    const contractBefore = JSON.stringify(service.getRun(run.id).executionContract);

    const result = await service.retryExecutionContractProposal(run.id);

    expect(result).toMatchObject({
      applied: false,
      failureCode: "rate_limited",
      notice:
        "AI proposal unavailable: temporarily rate limited. Your current contract was preserved.",
      run: { status: "awaiting_approval" },
    });
    expect(JSON.stringify(service.getRun(run.id).executionContract)).toBe(
      contractBefore,
    );
    expect(result.notice).not.toContain("Raw secret");
    expect(runner.calls).toHaveLength(0);
    await service.cancelRun(run.id);
  });

  it("rejects a stale proposal retry instead of overwriting a manual edit", async () => {
    let releaseRetry!: (proposal: ContractProposal) => void;
    let proposalCall = 0;
    const planner: ContractPlanner = {
      async propose() {
        proposalCall += 1;
        if (proposalCall === 1) {
          throw new ContractPlanningError("Unavailable", "provider_error");
        }
        return new Promise<ContractProposal>((resolve) => {
          releaseRetry = resolve;
        });
      },
      async amend() {
        throw new Error("Not used");
      },
    };
    const runner = new FakeRunner();
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Stale retry" });
    const { run } = await service.sendMessage(agent.id, "Update source");

    const retry = service.retryExecutionContractProposal(run.id);
    await expect.poll(() => proposalCall).toBe(2);
    await service.updateExecutionContract(run.id, {
      protectedPaths: [".env", "deployment", "package.json"],
    });
    releaseRetry(basicProposal);

    await expect(retry).rejects.toMatchObject({ statusCode: 409 });
    expect(service.getRun(run.id).executionContract?.protectedPaths).toEqual([
      ".env",
      "deployment",
      "package.json",
    ]);
    expect(runner.calls).toHaveLength(0);
    await service.cancelRun(run.id);
  });

  it("rejects proposal retry after cancellation", async () => {
    const service = await makeService(
      new FakeRunner(),
      {},
      new FakePlanner(new ContractPlanningError("Unavailable", "provider_error")),
    );
    const agent = await service.createAgent({ name: "Cancelled retry" });
    const { run } = await service.sendMessage(agent.id, "Update source");
    await service.cancelRun(run.id);

    await expect(service.retryExecutionContractProposal(run.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("lets a human add and remove writable authority without invoking the runner", async () => {
    const runner = new FakeRunner();
    const service = await makeService(
      runner,
      {},
      new FakePlanner(new ContractPlanningError("Unavailable", "provider_error")),
    );
    const agent = await service.createAgent({ name: "Manual authority" });
    await mkdir(path.join(agent.workspacePath, "src"));
    const { run } = await service.sendMessage(agent.id, "Update source");

    const added = await service.updateExecutionContract(run.id, {
      writablePaths: ["src/**", "tests/**"],
    });
    expect(added.executionContract).toMatchObject({
      writablePaths: ["src/**", "tests/**"],
      protectedPaths: [".env", "deployment"],
      approvedAt: null,
    });
    const removed = await service.updateExecutionContract(run.id, {
      writablePaths: ["src/**"],
    });
    expect(removed.executionContract).toMatchObject({ writablePaths: ["src/**"] });
    expect(runner.calls).toHaveLength(0);

    await service.approveRun(run.id);
    await expect.poll(() => runner.calls.length).toBe(1);
    expect(runner.calls[0]).toMatchObject({
      writablePaths: ["src/**"],
      protectedPaths: [".env", "deployment"],
    });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("treats an approved empty writable scope as a completely read-only workspace", async () => {
    const runner = new FakeRunner();
    const service = await makeService(
      runner,
      {},
      new FakePlanner(new Error("provider returned 429")),
    );
    const agent = await service.createAgent({ name: "Read only fallback" });
    const { run } = await service.sendMessage(agent.id, "Inspect without changes");

    await service.approveRun(run.id);
    await expect.poll(() => runner.calls.length).toBe(1);
    expect(runner.calls[0]?.writablePaths).toEqual([]);
    expect(runner.calls[0]?.authorityPlan.writableMounts).toEqual([]);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("falls back safely when planning returns invalid paths", async () => {
    for (const planner of [
      new FakePlanner({
        ...basicProposal,
        writablePaths: ["../outside"],
      }),
      new FakePlanner({
        ...basicProposal,
        protectedPaths: Array.from({ length: 100 }, (_, index) => "safe-" + index),
      }),
    ]) {
      const runner = new FakeRunner();
      const service = await makeService(runner, {}, planner);
      const agent = await service.createAgent({ name: "Fallback" });

      const { run } = await service.sendMessage(agent.id, "Review manually");

      expect(run).toMatchObject({
        status: "awaiting_approval",
        executionContract: {
          version: 1,
          goal: "Review manually",
          writablePaths: [],
          protectedPaths: [".env", "deployment"],
          riskLevel: "medium",
          proposalSource: "fallback",
          proposalNotice:
            "AI proposal unavailable: the proposal contained an invalid workspace path. Configure authority manually or retry AI proposal.",
          approvedAt: null,
        },
      });
      expect(runner.calls).toHaveLength(0);
      await service.cancelRun(run.id);
    }
  });

  it("lets a human protect an AI-proposed writable path before approval", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner({
      goal: "Improve authentication",
      plannedActions: ["Update authentication logic", "Run authentication tests"],
      writablePaths: ["src/auth.ts"],
      protectedPaths: [],
      riskLevel: "medium",
      rationale: "The implementation change is limited to authentication source.",
    });
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Human override" });

    const { run } = await service.sendMessage(agent.id, "Improve authentication");
    expect(run.executionContract).toMatchObject({
      version: 1,
      proposalSource: "ai",
      writablePaths: ["src/auth.ts"],
      protectedPaths: [".env", "deployment"],
    });
    expect(runner.calls).toHaveLength(0);

    const amended = await service.updateExecutionContract(run.id, {
      protectedPaths: [
        ...(run.executionContract?.protectedPaths ?? []),
        "src/auth.ts",
      ],
    });
    expect(amended.executionContract).toMatchObject({
      writablePaths: ["src/auth.ts"],
      protectedPaths: [".env", "deployment", "src/auth.ts"],
      approvedAt: null,
    });
    expect(runner.calls).toHaveLength(0);

    await service.approveRun(run.id);
    await expect.poll(() => runner.calls.length).toBe(1);
    expect(runner.calls[0]?.protectedPaths).toEqual([
      ".env",
      "deployment",
      "src/auth.ts",
    ]);
    expect(service.getRun(run.id).executionContract).toMatchObject({
      protectedPaths: [".env", "deployment", "src/auth.ts"],
      approvedAt: expect.any(String),
    });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("negotiates repeatedly, preserves human protections, and runs only after approval", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner(basicProposal, [
      {
        goal: "Complete the requested task",
        plannedActions: ["Update authentication source", "Run focused tests"],
        writablePaths: ["src/auth/**"],
        protectedPaths: [".env", "deployment/", "deployment/config.yml"],
        riskLevel: "low",
        rationale: "The human restricted changes to authentication source.",
        removedProtectedPaths: [],
      },
      {
        goal: "Complete the requested task",
        plannedActions: ["Update authentication source", "Run focused tests"],
        writablePaths: ["src/auth/**"],
        protectedPaths: [".env", "deployment", "infra/secrets"],
        riskLevel: "medium",
        rationale: "Infrastructure secrets must also remain protected.",
        removedProtectedPaths: [],
      },
    ]);
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Negotiator" });
    await mkdir(path.join(agent.workspacePath, "src"));
    const { run } = await service.sendMessage(agent.id, "Update authentication");
    const humanEdited = await service.updateExecutionContract(run.id, {
      protectedPaths: [
        ...(run.executionContract?.protectedPaths ?? []),
        "package.json",
      ],
    });

    const firstRevision = await service.negotiateExecutionContract(
      run.id,
      "Only touch src/auth.",
    );

    expect(firstRevision).toMatchObject({
      applied: true,
      notice: null,
      run: {
        status: "awaiting_approval",
        executionContract: {
          writablePaths: ["src/auth/**"],
          protectedPaths: [".env", "deployment", "package.json"],
          proposalSource: "ai",
          approvedAt: null,
        },
      },
    });
    expect(planner.amendmentCalls[0]).toMatchObject({
      task: "Update authentication",
      amendmentInstruction: "Only touch src/auth.",
      currentContract: humanEdited.executionContract,
    });
    expect(runner.calls).toHaveLength(0);

    const secondRevision = await service.negotiateExecutionContract(
      run.id,
      "Protect infra/secrets too.",
    );
    expect(planner.amendmentCalls[1]?.currentContract).toEqual(
      firstRevision.run.executionContract,
    );
    expect(secondRevision.run.executionContract).toMatchObject({
      writablePaths: ["src/auth/**"],
      protectedPaths: [".env", "deployment", "package.json", "infra/secrets"],
      riskLevel: "medium",
    });
    expect(runner.calls).toHaveLength(0);

    const manuallyEdited = await service.updateExecutionContract(run.id, {
      protectedPaths: [
        ...(secondRevision.run.executionContract?.protectedPaths ?? []),
        "src/auth.ts",
      ],
      writablePaths: ["src/**"],
    });
    expect(manuallyEdited.executionContract).toMatchObject({
      writablePaths: ["src/**"],
    });
    expect(manuallyEdited.executionContract?.protectedPaths).toEqual([
      ".env",
      "deployment",
      "package.json",
      "infra/secrets",
      "src/auth.ts",
    ]);
    expect(runner.calls).toHaveLength(0);

    await service.approveRun(run.id);
    await expect.poll(() => runner.calls.length).toBe(1);
    expect(runner.calls[0]?.protectedPaths).toEqual([
      ".env",
      "deployment",
      "package.json",
      "infra/secrets",
      "src/auth.ts",
    ]);
    expect(runner.calls[0]?.writablePaths).toEqual(["src/**"]);
    await expect(service.negotiateExecutionContract(run.id, "Change it again")).rejects
      .toMatchObject({ statusCode: 409 });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it.each([
    ["provider returned 429", new Error("provider returned 429")],
    ["planner returned malformed JSON", new Error("planner returned malformed JSON")],
    [
      "planner returned invalid paths",
      {
        ...basicProposal,
        writablePaths: ["../outside"],
        removedProtectedPaths: [],
      },
    ],
  ] as Array<[string, ContractAmendment | Error]>)(
    "preserves the current contract exactly when negotiation fails: %s",
    async (_failureName, amendmentResult) => {
      const runner = new FakeRunner();
      const planner = new FakePlanner(basicProposal, [amendmentResult]);
      const service = await makeService(runner, {}, planner);
      const agent = await service.createAgent({ name: "Preserved" });
      const { run } = await service.sendMessage(agent.id, "Update authentication");
      await service.updateExecutionContract(run.id, {
        protectedPaths: [
          ...(run.executionContract?.protectedPaths ?? []),
          "package.json",
        ],
      });
      const contractBefore = JSON.stringify(service.getRun(run.id).executionContract);

      const result = await service.negotiateExecutionContract(
        run.id,
        "Only touch src/auth.",
      );

      expect(result).toMatchObject({
        applied: false,
        notice: "Unable to apply negotiation — current contract was preserved.",
        run: { status: "awaiting_approval" },
      });
      expect(JSON.stringify(service.getRun(run.id).executionContract)).toBe(
        contractBefore,
      );
      expect(runner.calls).toHaveLength(0);
      await service.cancelRun(run.id);
    },
  );

  it("removes an existing protection only through explicit structured removal intent", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner(basicProposal, [
      {
        ...basicProposal,
        protectedPaths: [".env", "deployment"],
        removedProtectedPaths: ["package.json"],
      },
    ]);
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Explicit removal" });
    const { run } = await service.sendMessage(agent.id, "Update source");
    await service.updateExecutionContract(run.id, {
      protectedPaths: [
        ...(run.executionContract?.protectedPaths ?? []),
        "package.json",
      ],
    });

    const result = await service.negotiateExecutionContract(
      run.id,
      "Remove protection from package.json.",
    );

    expect(result.run.executionContract?.protectedPaths).toEqual([
      ".env",
      "deployment",
    ]);
    expect(runner.calls).toHaveLength(0);
    await service.cancelRun(run.id);
  });

  it("amends, freezes, and passes the approved contract exactly once", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Guarded" });
    const { run } = await service.sendMessage(agent.id, "change source only");

    const amended = await service.updateExecutionContract(run.id, {
      protectedPaths: ["package.json", "infra/secrets"],
    });
    expect(amended.executionContract?.protectedPaths).toEqual([
      "package.json",
      "infra/secrets",
    ]);
    expect(runner.calls).toHaveLength(0);

    const approvals = await Promise.allSettled([
      service.approveRun(run.id),
      service.approveRun(run.id),
    ]);
    expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect.poll(() => runner.calls.length).toBe(1);
    expect(runner.calls[0]?.protectedPaths).toEqual([
      "package.json",
      "infra/secrets",
    ]);

    const persisted = service.getRun(run.id);
    expect(persisted.executionContract?.approvedAt).not.toBeNull();
    expect(persisted.executionContract?.protectedPaths).toEqual(
      runner.calls[0]?.protectedPaths,
    );
    await expect(
      service.updateExecutionContract(run.id, { protectedPaths: ["different"] }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("never executes a cancelled or unapproved Run", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Cancelled" });
    const { run } = await service.sendMessage(agent.id, "do not run");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.calls).toHaveLength(0);
    expect((await service.cancelRun(run.id)).status).toBe("cancelled");
    expect(service.getAgent(agent.id).status).toBe("ready");
    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(runner.calls).toHaveLength(0);
  });

  it("does not approve an unenforced local-process contract", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner, { RUNTIME_PROVIDER: "local-process" });
    const agent = await service.createAgent({ name: "Local" });
    const { run } = await service.sendMessage(agent.id, "must stay protected");

    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(service.getRun(run.id).status).toBe("awaiting_approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a legacy V0 pending Run instead of using weaker authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-v0-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      RUNTIME_PROVIDER: "container",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const runner = new FakeRunner();
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
      new FakePlanner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Legacy" });
    const { run } = await service.sendMessage(agent.id, "legacy pending task");
    await store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id)!;
      storedRun.executionContract = {
        version: 0,
        protectedPaths: [".env"],
        approvedAt: null,
        updatedAt: new Date().toISOString(),
      };
    });

    await expect(service.approveRun(run.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("cancel and resubmit"),
    });
    expect(service.getRun(run.id).status).toBe("awaiting_approval");
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    [[""], "between 1 and 512"],
    [["/etc"], "workspace-relative"],
    [["../secret"], "workspace-relative"],
    [["deployment\\secret"], "workspace-relative"],
    [["deployment,src"], "workspace-relative"],
  ])("rejects invalid protected paths %#", async (protectedPaths, message) => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Invalid" });
    const { run } = await service.sendMessage(agent.id, "validate contract");
    await expect(
      service.updateExecutionContract(run.id, { protectedPaths }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(message),
    });
  });

  it.each([
    [[""], "between 1 and 512"],
    [["/etc"], "workspace-relative"],
    [["../outside"], "workspace-relative"],
    [["missing/file.ts"], "parent does not exist"],
  ])("rejects invalid writable paths %#", async (writablePaths, message) => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Invalid writable" });
    const { run } = await service.sendMessage(agent.id, "validate authority");
    await expect(
      service.updateExecutionContract(run.id, { writablePaths }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(message),
    });
  });

  it("preserves an awaiting-approval contract across restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-restart-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      RUNTIME_PROVIDER: "container",
    });
    const workspace = new WorkspaceManager(path.join(root, "workspaces"));
    const first = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      workspace,
      new FakeRunner(),
    );
    await first.initialize();
    const agent = await first.createAgent({ name: "Persistent" });
    const { run } = await first.sendMessage(agent.id, "wait for approval");
    await first.updateExecutionContract(run.id, {
      protectedPaths: [".env", "ops"],
      writablePaths: ["src/**"],
    });

    const runnerAfterRestart = new FakeRunner();
    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      workspace,
      runnerAfterRestart,
    );
    await restarted.initialize();

    expect(restarted.getRun(run.id)).toMatchObject({
      status: "awaiting_approval",
      executionContract: {
        protectedPaths: [".env", "ops"],
        writablePaths: ["src/**"],
        approvedAt: null,
      },
    });
    expect(restarted.getAgent(agent.id).status).toBe("busy");
    expect(runnerAfterRestart.calls).toHaveLength(0);
  });

  it("atomically accepts only one pending Run per Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(service.getMessages(agent.id)).toHaveLength(1);
  });

  it("does not let start reset an Agent reserved for approval", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });
    await service.cancelRun(run.id);
  });
});
