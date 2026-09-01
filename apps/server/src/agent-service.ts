import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  ContractPlanningError,
  parseContractAmendment,
  parseContractProposal,
  type ContractAmendment,
  type ContractPlanningFailureCode,
  type ContractPlanner,
  type ContractProposal,
  type ContractSchemaIssue,
} from "./contract-planner.js";
import { HttpError, RunCancelledError, RunExecutionError } from "./errors.js";
import { mergeExecutionEvidence } from "./execution-events.js";
import {
  DEFAULT_PROTECTED_PATHS,
  InvalidProtectedPathError,
  mergeProtectedPaths,
  normalizeProtectedPaths,
  normalizeWritablePaths,
} from "./protected-paths.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  ExecutionContract,
  ExecutionContractV1,
  Message,
  RunEvent,
  RunStatus,
  RunnerResult,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import {
  compileWorkspaceAuthority,
  prepareWorkspaceAuthority,
  validateWorkspaceAuthorityDraft,
  WorkspaceAuthorityError,
} from "./workspace-authority.js";
import {
  captureWorkspaceManifest,
  compareWorkspaceManifests,
  type WorkspaceDiffStatus,
} from "./workspace-manifest.js";
import {
  RollbackSnapshotError,
  RollbackSnapshotManager,
  type CreatedRollbackSnapshot,
} from "./rollback-snapshot.js";

const now = () => new Date().toISOString();
export const AI_PROPOSAL_UNAVAILABLE_NOTICE =
  "AI proposal unavailable — configure authority manually or retry AI proposal.";
export const NEGOTIATION_PRESERVED_NOTICE =
  "Unable to apply negotiation — current contract was preserved.";

export interface ExecutionContractUpdate {
  protectedPaths?: readonly string[] | undefined;
  writablePaths?: readonly string[] | undefined;
}

export interface ContractProposalRetryResult {
  run: AgentRun;
  applied: boolean;
  notice: string | null;
  failureCode: ContractPlanningFailureCode | null;
}

export interface PlannerDiagnostic {
  operation: "proposal" | "retry" | "negotiation";
  code: ContractPlanningFailureCode;
  status: number | null;
  model: string;
  durationMs: number | null;
  retryCount: number;
  schemaIssues?: readonly ContractSchemaIssue[];
}

type PlannerDiagnosticLogger = (diagnostic: PlannerDiagnostic) => void;

const failureDescription: Record<ContractPlanningFailureCode, string> = {
  rate_limited: "temporarily rate limited",
  timeout: "the request timed out",
  authentication_failed: "planner authentication failed",
  no_output_text: "no usable proposal was returned",
  refusal: "the planner declined the request",
  malformed_json: "the response was not valid JSON",
  schema_invalid: "the proposal failed schema validation",
  path_invalid: "the proposal contained an invalid workspace path",
  provider_error: "the provider request failed",
};

function planningError(error: unknown): ContractPlanningError {
  return error instanceof ContractPlanningError
    ? error
    : new ContractPlanningError("Planner request failed", "provider_error");
}

function proposalUnavailableNotice(
  error: ContractPlanningError,
  currentContractPreserved: boolean,
): string {
  return (
    "AI proposal unavailable: " +
    failureDescription[error.code] +
    ". " +
    (currentContractPreserved
      ? "Your current contract was preserved."
      : "Configure authority manually or retry AI proposal.")
  );
}

export interface ContractNegotiationResult {
  run: AgentRun;
  applied: boolean;
  notice: string | null;
}

const unavailablePlanner: ContractPlanner = {
  async propose() {
    throw new ContractPlanningError("Planner is unavailable");
  },
  async amend() {
    throw new ContractPlanningError("Planner is unavailable");
  },
};

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly activeRecoveries = new Map<string, Promise<AgentRun>>();
  private readonly activeSubmissions = new Set<string>();
  private readonly cancellationRequests = new Set<string>();
  private readonly rollbackSnapshots: RollbackSnapshotManager;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly planner: ContractPlanner = unavailablePlanner,
    private readonly logPlannerDiagnostic: PlannerDiagnosticLogger = () => undefined,
    rollbackSnapshots?: RollbackSnapshotManager,
  ) {
    this.rollbackSnapshots =
      rollbackSnapshots ??
      new RollbackSnapshotManager(config.dataDirectory, config.workspaceRoot);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.rollbackSnapshots.initialize(this.store.snapshot().agents);
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
    await this.waitForRecovery(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    await this.rollbackSnapshots.removeAgent(id).catch(() => undefined);
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.waitForRecovery(id);
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
    const agentForPlanning = this.getAgent(agentId);
    if (agentForPlanning.status === "stopped") {
      throw new HttpError(409, "Start the Agent before sending a message");
    }
    if (agentForPlanning.status === "busy") {
      throw new HttpError(409, "This Agent is already running");
    }
    if (
      this.activeRecoveries.has(agentId) ||
      this.activeSubmissions.has(agentId)
    ) {
      throw new HttpError(409, "This Agent already has an active operation");
    }

    this.activeSubmissions.add(agentId);
    try {
      let proposal: ContractProposal | null = null;
      let proposalFailure: ContractPlanningError | null = null;
      try {
        proposal = await this.generateContractProposal(agentForPlanning, prompt);
      } catch (error) {
        proposalFailure = planningError(error);
        this.reportPlannerFailure("proposal", proposalFailure);
        proposal = null;
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
        events: [],
        executionContract: this.buildExecutionContract(
          prompt,
          proposal,
          proposalFailure,
          timestamp,
        ),
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
    } finally {
      this.activeSubmissions.delete(agentId);
    }
  }

  async updateExecutionContract(
    runId: string,
    update: ExecutionContractUpdate,
  ): Promise<AgentRun> {
    try {
      return await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runId);
        if (!run) throw new HttpError(404, "Run not found");
        if (run.status !== "awaiting_approval" || !run.executionContract) {
          throw new HttpError(409, "Execution Contract can no longer be edited");
        }
        if (update.writablePaths !== undefined && run.executionContract.version !== 1) {
          throw new HttpError(409, "Legacy V0 contracts have no writable authority");
        }
        const agent = database.agents.find((item) => item.id === run.agentId);
        if (!agent) throw new HttpError(404, "Agent not found");
        const authority = validateWorkspaceAuthorityDraft({
          workspacePath: agent.workspacePath,
          writablePaths:
            update.writablePaths ??
            (run.executionContract.version === 1
              ? run.executionContract.writablePaths
              : []),
          protectedPaths:
            update.protectedPaths ?? run.executionContract.protectedPaths,
        });
        run.executionContract.protectedPaths = authority.protectedPaths;
        if (run.executionContract.version === 1) {
          run.executionContract.writablePaths = authority.writablePaths;
        }
        run.executionContract.updatedAt = now();
        return structuredClone(run);
      });
    } catch (error) {
      if (
        error instanceof InvalidProtectedPathError ||
        error instanceof WorkspaceAuthorityError
      ) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
  }

  async retryExecutionContractProposal(
    runId: string,
  ): Promise<ContractProposalRetryResult> {
    const runAtStart = this.getRun(runId);
    if (
      runAtStart.status !== "awaiting_approval" ||
      runAtStart.executionContract?.version !== 1 ||
      runAtStart.executionContract.proposalSource !== "fallback"
    ) {
      throw new HttpError(
        409,
        "Only a fallback V1 contract awaiting approval can retry its AI proposal",
      );
    }
    const contractAtStart = structuredClone(runAtStart.executionContract);
    const serializedContractAtStart = JSON.stringify(contractAtStart);
    const agent = this.getAgent(runAtStart.agentId);

    let proposal: ContractProposal;
    try {
      proposal = await this.generateContractProposal(agent, runAtStart.prompt);
    } catch (error) {
      const failure = planningError(error);
      this.reportPlannerFailure("retry", failure);
      const preservedRun = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        if (
          !storedRun ||
          storedRun.status !== "awaiting_approval" ||
          storedRun.executionContract?.version !== 1
        ) {
          throw new HttpError(409, "Run is no longer awaiting proposal retry");
        }
        if (
          JSON.stringify(storedRun.executionContract) !== serializedContractAtStart
        ) {
          throw new HttpError(
            409,
            "Execution Contract changed while proposal retry was in progress",
          );
        }
        return structuredClone(storedRun);
      });
      return {
        run: preservedRun,
        applied: false,
        notice: proposalUnavailableNotice(failure, true),
        failureCode: failure.code,
      };
    }

    const updatedAt = now();
    const run = await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (
        !storedRun ||
        storedRun.status !== "awaiting_approval" ||
        storedRun.executionContract?.version !== 1 ||
        storedRun.executionContract.proposalSource !== "fallback"
      ) {
        throw new HttpError(409, "Run is no longer awaiting proposal retry");
      }
      if (JSON.stringify(storedRun.executionContract) !== serializedContractAtStart) {
        throw new HttpError(
          409,
          "Execution Contract changed while proposal retry was in progress",
        );
      }
      Object.assign(storedRun.executionContract, proposal, {
        protectedPaths: mergeProtectedPaths(
          contractAtStart.protectedPaths,
          proposal.protectedPaths,
        ),
        proposalSource: "ai",
        proposalNotice: null,
        approvedAt: null,
        updatedAt,
      } satisfies Partial<ExecutionContractV1>);
      return structuredClone(storedRun);
    });
    return { run, applied: true, notice: null, failureCode: null };
  }

  async negotiateExecutionContract(
    runId: string,
    amendmentInstruction: string,
  ): Promise<ContractNegotiationResult> {
    const runAtStart = this.getRun(runId);
    if (
      runAtStart.status !== "awaiting_approval" ||
      runAtStart.executionContract?.version !== 1
    ) {
      throw new HttpError(409, "Run is not awaiting negotiation on a V1 contract");
    }
    const contractAtStart = structuredClone(runAtStart.executionContract);
    const serializedContractAtStart = JSON.stringify(contractAtStart);
    const agent = this.getAgent(runAtStart.agentId);
    const preserveCurrentContract = (): ContractNegotiationResult => {
      const preservedRun = this.getRun(runId);
      if (
        preservedRun.status !== "awaiting_approval" ||
        preservedRun.executionContract?.version !== 1
      ) {
        throw new HttpError(409, "Run is no longer awaiting negotiation");
      }
      if (JSON.stringify(preservedRun.executionContract) !== serializedContractAtStart) {
        throw new HttpError(
          409,
          "Execution Contract changed while negotiation was in progress",
        );
      }
      return {
        run: preservedRun,
        applied: false,
        notice: NEGOTIATION_PRESERVED_NOTICE,
      };
    };

    let amendment: ContractAmendment;
    let protectedPaths: string[];
    try {
      const workspaceInventory = await this.workspaces.readInventory(
        agent.workspacePath,
      );
      amendment = parseContractAmendment(
        await this.planner.amend({
          task: runAtStart.prompt,
          agentInstructions: agent.instructions,
          currentContract: contractAtStart,
          amendmentInstruction,
          workspaceInventory,
        }),
      );
      const currentProtectedPaths = normalizeProtectedPaths(
        contractAtStart.protectedPaths,
      );
      const currentProtectedSet = new Set(currentProtectedPaths);
      if (
        amendment.removedProtectedPaths.some(
          (protectedPath) => !currentProtectedSet.has(protectedPath),
        )
      ) {
        throw new ContractPlanningError(
          "Planner requested removal of a path that is not currently protected",
        );
      }
      const removals = new Set(amendment.removedProtectedPaths);
      protectedPaths = mergeProtectedPaths(
        currentProtectedPaths.filter(
          (protectedPath) => !removals.has(protectedPath),
        ),
        amendment.protectedPaths.filter(
          (protectedPath) => !removals.has(protectedPath),
        ),
      );
    } catch (error) {
      this.reportPlannerFailure("negotiation", planningError(error));
      return preserveCurrentContract();
    }
    const { removedProtectedPaths: _removedProtectedPaths, ...revisedProposal } =
      amendment;
    const updatedAt = now();

    const run = await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (
        !storedRun ||
        storedRun.status !== "awaiting_approval" ||
        storedRun.executionContract?.version !== 1
      ) {
        throw new HttpError(409, "Run is no longer awaiting negotiation");
      }
      if (JSON.stringify(storedRun.executionContract) !== serializedContractAtStart) {
        throw new HttpError(
          409,
          "Execution Contract changed while negotiation was in progress",
        );
      }

      Object.assign(storedRun.executionContract, revisedProposal, {
        protectedPaths,
        proposalSource: "ai",
        proposalNotice: null,
        approvedAt: null,
        updatedAt,
      } satisfies Partial<ExecutionContractV1>);
      return structuredClone(storedRun);
    });
    return { run, applied: true, notice: null };
  }

  async approveRun(runId: string): Promise<AgentRun> {
    if (this.config.runtimeProvider !== "container") {
      throw new HttpError(
        409,
        "Execution Contracts require the container Runtime provider",
      );
    }
    const approvedAt = now();
    let approved: { run: AgentRun; agent: Agent };
    try {
      approved = await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runId);
        if (!run) throw new HttpError(404, "Run not found");
        if (run.status !== "awaiting_approval" || !run.executionContract) {
          throw new HttpError(409, "Run is not awaiting approval");
        }
        if (run.executionContract.version !== 1) {
          throw new HttpError(
            409,
            "Legacy V0 contracts have no writable authority; cancel and resubmit this Run",
          );
        }
        const agent = database.agents.find((item) => item.id === run.agentId);
        if (!agent) throw new HttpError(404, "Agent not found");
        if (agent.status === "stopped") {
          throw new HttpError(409, "Start the Agent before approving this Run");
        }

        const authority = prepareWorkspaceAuthority({
          workspacePath: agent.workspacePath,
          writablePaths: normalizeWritablePaths(run.executionContract.writablePaths),
          protectedPaths: normalizeProtectedPaths(
            run.executionContract.protectedPaths,
          ),
        });
        run.executionContract.writablePaths = authority.writablePaths;
        run.executionContract.protectedPaths = authority.protectedPaths;
        run.executionContract.approvedAt = approvedAt;
        run.executionContract.updatedAt = approvedAt;
        run.authorityPreparations = authority.preparations;
        run.status = "queued";
        agent.status = "busy";
        agent.lastError = null;
        agent.updatedAt = approvedAt;
        return { run: structuredClone(run), agent: structuredClone(agent) };
      });
    } catch (error) {
      if (
        error instanceof InvalidProtectedPathError ||
        error instanceof WorkspaceAuthorityError
      ) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
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

  async rollbackRun(runId: string): Promise<AgentRun> {
    const run = this.getRun(runId);
    if (run.rollback?.status === "restored") return run;
    if (!(["completed", "failed", "cancelled"] as RunStatus[]).includes(run.status)) {
      throw new HttpError(409, "Only a terminal Run can be rolled back");
    }
    if (this.activeExecutions.has(run.agentId)) {
      throw new HttpError(409, "Wait for the active Run to finish before rollback");
    }
    if (this.activeSubmissions.has(run.agentId)) {
      throw new HttpError(409, "Wait for the pending task submission before rollback");
    }
    if (this.activeRecoveries.has(run.agentId)) {
      throw new HttpError(409, "Rollback is already in progress for this Agent");
    }
    const recovery = this.performRollback(runId);
    this.activeRecoveries.set(run.agentId, recovery);
    try {
      return await recovery;
    } finally {
      if (this.activeRecoveries.get(run.agentId) === recovery) {
        this.activeRecoveries.delete(run.agentId);
      }
    }
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

  private buildExecutionContract(
    prompt: string,
    proposal: ContractProposal | null,
    proposalFailure: ContractPlanningError | null,
    timestamp: string,
  ): ExecutionContract {
    if (!proposal) {
      return {
        version: 1,
        goal: prompt,
        plannedActions: [
          "Review the task and workspace before making changes",
          "Define the intended writable scope manually",
          "Verify the result after execution",
        ],
        writablePaths: [],
        protectedPaths: [...DEFAULT_PROTECTED_PATHS],
        riskLevel: "medium",
        rationale: null,
        proposalSource: "fallback",
        proposalNotice: proposalFailure
          ? proposalUnavailableNotice(proposalFailure, false)
          : AI_PROPOSAL_UNAVAILABLE_NOTICE,
        approvedAt: null,
        updatedAt: timestamp,
      };
    }

    return {
      version: 1,
      ...proposal,
      proposalSource: "ai",
      proposalNotice: null,
      approvedAt: null,
      updatedAt: timestamp,
    };
  }

  private async generateContractProposal(
    agent: Agent,
    prompt: string,
  ): Promise<ContractProposal> {
    const workspaceInventory = await this.workspaces.readInventory(
      agent.workspacePath,
    );
    const proposal = parseContractProposal(
      await this.planner.propose({
        task: prompt,
        agentInstructions: agent.instructions,
        workspaceInventory,
      }),
    );
    try {
      return {
        ...proposal,
        protectedPaths: mergeProtectedPaths(
          DEFAULT_PROTECTED_PATHS,
          proposal.protectedPaths,
        ),
      };
    } catch {
      throw new ContractPlanningError(
        "Planner proposal exceeded safe path limits",
        "path_invalid",
      );
    }
  }

  private reportPlannerFailure(
    operation: PlannerDiagnostic["operation"],
    error: ContractPlanningError,
  ): void {
    try {
      this.logPlannerDiagnostic({
        operation,
        code: error.code,
        status: error.status,
        model: this.config.arkPlannerModel,
        durationMs: error.durationMs,
        retryCount: error.retryCount,
        ...(error.schemaIssues ? { schemaIssues: error.schemaIssues } : {}),
      });
    } catch {
      // Diagnostics must never alter the contract lifecycle.
    }
  }

  private async executeRun(agentAtStart: Agent, runId: string): Promise<void> {
    let executionEvents: RunEvent[] = [];
    let workspaceDiffStatus: WorkspaceDiffStatus | undefined;
    let rollbackSnapshot: CreatedRollbackSnapshot | undefined;
    let executionBoundaryCommitted = false;
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
      if (run.executionContract?.version !== 1) {
        throw new Error("Run cannot execute without V1 writable authority");
      }
      const authorityPlan = compileWorkspaceAuthority({
        workspacePath: agentAtStart.workspacePath,
        writablePaths: run.executionContract.writablePaths,
        protectedPaths: run.executionContract.protectedPaths,
      });
      rollbackSnapshot = await this.rollbackSnapshots.create(
        agentAtStart.id,
        runId,
        agentAtStart.workspacePath,
      );
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        if (!storedRun || storedRun.status !== "running") {
          throw new Error("Run changed while its rollback snapshot was being created");
        }
        storedRun.rollback = {
          status: "available",
          snapshotId: rollbackSnapshot!.snapshotId,
          snapshotCreatedAt: rollbackSnapshot!.createdAt,
        };
      });
      const beforeManifest = await captureWorkspaceManifest(
        agentAtStart.workspacePath,
      );
      if (!this.rollbackSnapshots.matchesPreManifest(rollbackSnapshot, beforeManifest)) {
        throw new RollbackSnapshotError(
          "PRE workspace state did not match its rollback snapshot",
          "snapshot_failed",
        );
      }
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const executionBoundaryAt = now();
      const supersededSnapshots = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        if (
          !storedRun ||
          storedRun.status !== "running" ||
          storedRun.rollback?.status !== "available"
        ) {
          throw new Error("Run cannot cross the execution boundary safely");
        }
        storedRun.rollback.executionBoundaryAt = executionBoundaryAt;
        const superseded: Array<{ agentId: string; snapshotId: string }> = [];
        for (const olderRun of database.runs) {
          if (
            olderRun.id === runId ||
            olderRun.agentId !== agentAtStart.id ||
            olderRun.rollback?.status !== "available" ||
            !olderRun.rollback.snapshotId
          ) {
            continue;
          }
          superseded.push({
            agentId: olderRun.agentId,
            snapshotId: olderRun.rollback.snapshotId,
          });
          olderRun.rollback = {
            ...olderRun.rollback,
            status: "unavailable",
            unavailableReason: "newer_run_executed",
            supersededByRunId: runId,
          };
        }
        return superseded;
      });
      executionBoundaryCommitted = true;
      await Promise.all(
        supersededSnapshots.map((snapshot) =>
          this.rollbackSnapshots
            .remove(snapshot.agentId, snapshot.snapshotId)
            .catch(() => undefined),
        ),
      );
      let result: RunnerResult;
      try {
        result = await this.runner.run({
          agentId: agentAtStart.id,
          workspacePath: agentAtStart.workspacePath,
          prompt: run.prompt,
          threadId: agentAtStart.codexThreadId,
          writablePaths: run.executionContract.writablePaths,
          protectedPaths: run.executionContract.protectedPaths,
          authorityPlan,
        });
        executionEvents = result.events ?? [];
      } catch (error) {
        executionEvents =
          error instanceof RunExecutionError ? error.events : executionEvents;
        throw error;
      } finally {
        const afterManifest = await captureWorkspaceManifest(
          agentAtStart.workspacePath,
        );
        const workspaceDiff = compareWorkspaceManifests(
          beforeManifest,
          afterManifest,
        );
        workspaceDiffStatus = workspaceDiff.status;
        executionEvents = mergeExecutionEvidence(executionEvents, workspaceDiff);
      }
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.events = executionEvents;
        if (workspaceDiffStatus) {
          storedRun.workspaceDiffStatus = workspaceDiffStatus;
        }
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
      const snapshotFailed =
        error instanceof RollbackSnapshotError && !executionBoundaryCommitted;
      if (rollbackSnapshot && !executionBoundaryCommitted) {
        await this.rollbackSnapshots
          .remove(agentAtStart.id, rollbackSnapshot.snapshotId)
          .catch(() => undefined);
      }
      const message = snapshotFailed
        ? "Pre-run rollback snapshot could not be created; Codex was not started"
        : error instanceof Error
          ? error.message
          : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.events = executionEvents;
          if (workspaceDiffStatus) {
            storedRun.workspaceDiffStatus = workspaceDiffStatus;
          }
          if (!executionBoundaryCommitted && (snapshotFailed || rollbackSnapshot)) {
            storedRun.rollback = {
              status: "unavailable",
              unavailableReason: "snapshot_failed",
            };
          }
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

  private async performRollback(runId: string): Promise<AgentRun> {
    let priorAgentStatus: Agent["status"] = "ready";
    const reserved = await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) throw new HttpError(404, "Run not found");
      if (run.rollback?.status === "restored") return structuredClone(run);
      if (!(["completed", "failed", "cancelled"] as RunStatus[]).includes(run.status)) {
        throw new HttpError(409, "Only a terminal Run can be rolled back");
      }
      if (run.rollback?.status !== "available" || !run.rollback.snapshotId) {
        const message =
          run.rollback?.unavailableReason === "newer_run_executed"
            ? "A newer Run has already changed this workspace"
            : "This Run does not have an available rollback snapshot";
        throw new HttpError(409, message);
      }
      const conflictingRun = database.runs.some(
        (candidate) =>
          candidate.id !== run.id &&
          candidate.agentId === run.agentId &&
          ["awaiting_approval", "queued", "running"].includes(candidate.status),
      );
      if (conflictingRun) {
        throw new HttpError(
          409,
          "Resolve the newer pending or active Run before rollback",
        );
      }
      const agent = database.agents.find((item) => item.id === run.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Wait for the active Agent operation to finish");
      }
      priorAgentStatus = agent.status;
      agent.status = "busy";
      agent.updatedAt = now();
      return structuredClone(run);
    });
    if (reserved.rollback?.status === "restored") return reserved;

    try {
      await this.rollbackSnapshots.restore(
        reserved.agentId,
        reserved.id,
        reserved.rollback!.snapshotId!,
        this.getAgent(reserved.agentId).workspacePath,
      );
    } catch (error) {
      const snapshotError =
        error instanceof RollbackSnapshotError ? error : undefined;
      await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runId);
        const agent = run
          ? database.agents.find((item) => item.id === run.agentId)
          : undefined;
        if (
          run?.rollback?.status === "available" &&
          (snapshotError?.code === "snapshot_missing" ||
            snapshotError?.code === "snapshot_corrupt")
        ) {
          run.rollback = {
            ...run.rollback,
            status: "unavailable",
            unavailableReason:
              snapshotError.code === "snapshot_missing"
                ? "snapshot_missing"
                : "snapshot_corrupt",
          };
        }
        if (agent?.status === "busy") {
          agent.status = priorAgentStatus;
          agent.updatedAt = now();
        }
      });
      const message =
        snapshotError?.code === "snapshot_missing"
          ? "Rollback snapshot is missing"
          : snapshotError?.code === "snapshot_corrupt"
            ? "Rollback snapshot is corrupt"
            : "Workspace rollback could not be completed safely";
      throw new HttpError(409, message);
    }

    const restoredAt = now();
    const restored = await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run?.rollback || run.rollback.status !== "available") {
        throw new Error("Rollback state changed during workspace restoration");
      }
      const agent = database.agents.find((item) => item.id === run.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      run.rollback = { ...run.rollback, status: "restored", restoredAt };
      agent.status = priorAgentStatus;
      agent.updatedAt = restoredAt;
      return structuredClone(run);
    });
    await this.rollbackSnapshots
      .remove(restored.agentId, restored.rollback!.snapshotId!)
      .catch(() => undefined);
    return restored;
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

  private async waitForRecovery(agentId: string): Promise<void> {
    const recovery = this.activeRecoveries.get(agentId);
    if (recovery) await recovery.catch(() => undefined);
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
