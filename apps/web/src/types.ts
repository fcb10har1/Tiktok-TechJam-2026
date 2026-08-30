export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "awaiting_approval"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ContractPlanningFailureCode =
  | "rate_limited"
  | "timeout"
  | "authentication_failed"
  | "no_output_text"
  | "refusal"
  | "malformed_json"
  | "schema_invalid"
  | "path_invalid"
  | "provider_error";

export type RunEventKind =
  | "inspect"
  | "create"
  | "modify"
  | "delete"
  | "command"
  | "verify"
  | "blocked"
  | "warning";

export interface RunEvent {
  id: string;
  sequence: number;
  timestamp: string;
  kind: RunEventKind;
  outcome?: "success" | "failure" | "blocked";
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ExecutionContractV0 {
  version: 0;
  protectedPaths: string[];
  approvedAt: string | null;
  updatedAt: string;
}

export interface ExecutionContractV1 {
  version: 1;
  goal: string;
  plannedActions: string[];
  writablePaths: string[];
  protectedPaths: string[];
  riskLevel: "low" | "medium" | "high";
  rationale: string | null;
  proposalSource: "ai" | "fallback";
  proposalNotice: string | null;
  approvedAt: string | null;
  updatedAt: string;
}

export type ExecutionContract = ExecutionContractV0 | ExecutionContractV1;

export interface RunRollback {
  status: "available" | "restored" | "unavailable";
  snapshotId?: string;
  snapshotCreatedAt?: string;
  executionBoundaryAt?: string;
  restoredAt?: string;
  unavailableReason?:
    | "snapshot_failed"
    | "newer_run_executed"
    | "snapshot_missing"
    | "snapshot_corrupt";
  supersededByRunId?: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  executionContract?: ExecutionContract;
  authorityPreparations?: Array<{
    path: string;
    kind: "file" | "directory";
    purpose: "writable" | "protected";
    existedBeforeRun: false;
  }>;
  events?: RunEvent[];
  workspaceDiffStatus?: "complete" | "partial" | "unavailable";
  rollback?: RunRollback;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
