export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "awaiting_approval"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export type RunEventKind =
  | "inspect"
  | "create"
  | "modify"
  | "delete"
  | "command"
  | "verify"
  | "blocked"
  | "warning";

export type RunEventOutcome = "success" | "failure" | "blocked";

export interface RunEvent {
  id: string;
  sequence: number;
  timestamp: string;
  kind: RunEventKind;
  outcome?: RunEventOutcome;
  path?: string;
  authorityReason?: "explicitly_protected" | "outside_write_authority";
  technical: {
    source: "codex-jsonl" | "workspace-diff";
    itemType: "command_execution" | "workspace_manifest";
    itemId?: string;
    exitCode?: number;
    command?: string;
  };
}

export interface ExecutionContractV0 {
  version: 0;
  protectedPaths: string[];
  approvedAt: string | null;
  updatedAt: string;
}

export type ContractRiskLevel = "low" | "medium" | "high";

export interface ExecutionContractV1 {
  version: 1;
  goal: string;
  plannedActions: string[];
  writablePaths: string[];
  protectedPaths: string[];
  riskLevel: ContractRiskLevel;
  rationale: string | null;
  proposalSource: "ai" | "fallback";
  proposalNotice: string | null;
  approvedAt: string | null;
  updatedAt: string;
}

export type ExecutionContract = ExecutionContractV0 | ExecutionContractV1;

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  executionContract?: ExecutionContract;
  authorityPreparations?: AuthorityPreparation[];
  events?: RunEvent[];
  workspaceDiffStatus?: "complete" | "partial" | "unavailable";
}

export type AuthorityTargetKind = "file" | "directory";

export interface AuthorityPreparation {
  path: string;
  kind: AuthorityTargetKind;
  purpose: "writable" | "protected";
  existedBeforeRun: false;
}

export interface AuthorityMount {
  path: string;
  sourcePath: string;
  kind: AuthorityTargetKind;
}

export interface WorkspaceAuthorityPlan {
  workspaceSourcePath: string;
  writableMounts: AuthorityMount[];
  protectedMounts: AuthorityMount[];
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  events?: RunEvent[];
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  writablePaths: readonly string[];
  protectedPaths: readonly string[];
  authorityPlan: WorkspaceAuthorityPlan;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
