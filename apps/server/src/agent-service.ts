import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import {
  DEFAULT_PROTECTED_PATHS,
  InvalidProtectedPathError,
  normalizeProtectedPaths,
} from "./protected-paths.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        const awaitingApproval = database.runs.some(
          (run) => run.agentId === agent.id && run.status === "awaiting_approval",
        );
        if (agent.status === "busy" && !awaitingApproval) {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelAwaitingRuns(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "awaiting_approval",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      executionContract: {
        version: 0,
        protectedPaths: [...DEFAULT_PROTECTED_PATHS],
        approvedAt: null,
        updatedAt: timestamp,
      },
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
    });
    return { run, message };
  }

  async updateExecutionContract(
    runId: string,
    protectedPaths: readonly string[],
  ): Promise<AgentRun> {
    let normalizedPaths: string[];
    try {
      normalizedPaths = normalizeProtectedPaths(protectedPaths);
    } catch (error) {
      if (error instanceof InvalidProtectedPathError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }

    return this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) throw new HttpError(404, "Run not found");
      if (run.status !== "awaiting_approval" || !run.executionContract) {
        throw new HttpError(409, "Execution Contract can no longer be edited");
      }
      run.executionContract.protectedPaths = normalizedPaths;
      run.executionContract.updatedAt = now();
      return structuredClone(run);
    });
  }

  async approveRun(runId: string): Promise<AgentRun> {
    if (this.config.runtimeProvider !== "container") {
      throw new HttpError(
        409,
        "Execution Contract v0 requires the container Runtime provider",
      );
    }
    const approvedAt = now();
    const approved = await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) throw new HttpError(404, "Run not found");
      if (run.status !== "awaiting_approval" || !run.executionContract) {
        throw new HttpError(409, "Run is not awaiting approval");
      }
      const agent = database.agents.find((item) => item.id === run.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before approving this Run");
      }

      run.executionContract.protectedPaths = normalizeProtectedPaths(
        run.executionContract.protectedPaths,
      );
      run.executionContract.approvedAt = approvedAt;
      run.executionContract.updatedAt = approvedAt;
      run.status = "queued";
      agent.status = "busy";
      agent.lastError = null;
      agent.updatedAt = approvedAt;
      return { run: structuredClone(run), agent: structuredClone(agent) };
    });
    this.scheduleExecution(approved.agent, approved.run.id);
    return approved.run;
  }

  async cancelRun(runId: string): Promise<AgentRun> {
    const cancelledAt = now();
    return this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) throw new HttpError(404, "Run not found");
      if (run.status !== "awaiting_approval") {
        throw new HttpError(409, "Only a Run awaiting approval can be cancelled here");
      }
      run.status = "cancelled";
      run.error = "Cancelled before approval";
      run.completedAt = cancelledAt;
      if (run.executionContract) run.executionContract.updatedAt = cancelledAt;
      const agent = database.agents.find((item) => item.id === run.agentId);
      if (agent?.status === "busy") {
        agent.status = "ready";
        agent.updatedAt = cancelledAt;
      }
      return structuredClone(run);
    });
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private scheduleExecution(agent: Agent, runId: string): void {
    const execution = this.executeRun(agent, runId);
    this.activeExecutions.set(agent.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agent.id) === execution) {
          this.activeExecutions.delete(agent.id);
        }
      })
      .catch(() => undefined);
  }

  private async executeRun(agentAtStart: Agent, runId: string): Promise<void> {
    try {
      const run = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        if (
          !storedRun ||
          storedRun.status !== "queued" ||
          !storedRun.executionContract?.approvedAt
        ) {
          throw new Error("Run cannot execute without an approved Execution Contract");
        }
        storedRun.status = "running";
        storedRun.startedAt = now();
        return structuredClone(storedRun);
      });
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        protectedPaths: run.executionContract!.protectedPaths,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  private async cancelAwaitingRuns(agentId: string): Promise<void> {
    const cancelledAt = now();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.agentId === agentId && run.status === "awaiting_approval") {
          run.status = "cancelled";
          run.error = "Cancelled before approval because the Agent was stopped";
          run.completedAt = cancelledAt;
          if (run.executionContract) run.executionContract.updatedAt = cancelledAt;
        }
      }
    });
  }
}
