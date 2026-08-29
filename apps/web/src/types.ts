export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "awaiting_approval"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

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
