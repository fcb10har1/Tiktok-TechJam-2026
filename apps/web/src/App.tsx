import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import {
  displayableTechnicalCommandEvents,
  hasTestFileIntegrityWarning,
  resultingRegularFileChangesLabel,
  testCommandStatus,
} from "./observability";
import { runsByOwnerMessageId } from "./run-history";
import type { Agent, AgentRun, Message, RunEvent, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function StatusPill({ status, label }: { status: Agent["status"]; label?: string }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {label ?? status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

interface AuthorityPathSectionProps {
  title: string;
  tone: "writable" | "protected";
  paths: readonly string[];
  emptyText: string;
  description: string;
  addLabel: string;
  placeholder: string;
  inputValue: string;
  disabled: boolean;
  enforced?: boolean;
  collapseAfter?: number;
  onInputChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onRemove: (workspacePath: string) => void;
}

function AuthorityPathSection({
  title,
  tone,
  paths,
  emptyText,
  description,
  addLabel,
  placeholder,
  inputValue,
  disabled,
  enforced = false,
  collapseAfter,
  onInputChange,
  onSubmit,
  onRemove,
}: AuthorityPathSectionProps) {
  const visiblePaths = collapseAfter ? paths.slice(0, collapseAfter) : paths;
  const additionalPaths = collapseAfter ? paths.slice(collapseAfter) : [];
  const pathRows = (workspacePaths: readonly string[]) =>
    workspacePaths.map((workspacePath) => (
      <li key={workspacePath}>
        <code>{workspacePath}</code>
        <button
          type="button"
          className="path-remove-button"
          disabled={disabled}
          onClick={() => onRemove(workspacePath)}
          aria-label={"Remove " + tone + " path " + workspacePath}
          title={"Remove " + workspacePath}
        >
          <span aria-hidden="true">×</span>
        </button>
      </li>
    ));
  return (
    <section className={"contract-authority contract-authority-" + tone}>
      <div className="contract-section-heading">
        <strong>{title}</strong>
        {enforced && <span className="authority-badge">Enforced</span>}
      </div>
      {paths.length > 0 ? (
        <ul className="authority-path-list">
          {pathRows(visiblePaths)}
        </ul>
      ) : (
        <p className="contract-empty">{emptyText}</p>
      )}
      {additionalPaths.length > 0 && (
        <details className="authority-path-overflow">
          <summary>
            + {additionalPaths.length} more {tone} path
            {additionalPaths.length === 1 ? "" : "s"}
          </summary>
          <ul className="authority-path-list">{pathRows(additionalPaths)}</ul>
        </details>
      )}
      <details className="contract-path-editor">
        <summary>＋ {addLabel}</summary>
        <form className="contract-add-path" onSubmit={onSubmit}>
          <input
            value={inputValue}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={placeholder}
          />
          <button
            type="submit"
            className="button button-ghost"
            disabled={disabled || !inputValue.trim()}
          >
            Add
          </button>
        </form>
      </details>
      <p className="authority-description">{description}</p>
    </section>
  );
}

function eventDescription(event: RunEvent): string {
  if (event.kind === "inspect") return "Inspected " + event.path;
  if (event.kind === "create") return "Created " + event.path;
  if (event.kind === "modify") return "Modified " + event.path;
  if (event.kind === "delete") return "Deleted " + event.path;
  if (event.kind === "verify") {
    return event.outcome === "success"
      ? "Test command passed"
      : "Test command failed";
  }
  if (event.kind === "blocked") {
    return "Blocked " + event.path;
  }
  if (event.kind === "warning") {
    return event.path
      ? "Permission failure observed for " + event.path + "; authority attribution was inconclusive"
      : "Permission failure observed; authority attribution was inconclusive";
  }
  return event.outcome === "failure" ? "Command failed" : "Ran a command";
}

function eventSupportingText(event: RunEvent): string | null {
  if (event.kind !== "blocked") return null;
  return event.authorityReason === "explicitly_protected"
    ? "Explicitly protected"
    : "Outside approved write authority";
}

function eventGlyph(event: RunEvent): string {
  if (event.kind === "blocked") return "🚫";
  if (event.kind === "warning") return "⚠";
  return event.outcome === "failure" ? "×" : "✓";
}

function ApprovedContractRecord({
  run,
  current,
}: {
  run: AgentRun;
  current: boolean;
}) {
  const contract = run.executionContract;
  const [expanded, setExpanded] = useState(
    current && ["queued", "running"].includes(run.status),
  );
  useEffect(() => {
    if (!current) setExpanded(false);
  }, [current]);
  if (!contract?.approvedAt) return null;

  const writablePaths = contract.version === 1 ? contract.writablePaths : [];
  const riskLevel = contract.version === 1 ? contract.riskLevel : null;
  const summary = [
    writablePaths.length + " writable " + (writablePaths.length === 1 ? "scope" : "scopes"),
    contract.protectedPaths.length +
      " protected " +
      (contract.protectedPaths.length === 1 ? "path" : "paths"),
    riskLevel ? riskLevel.toUpperCase() + " RISK" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <details
      className={"approved-contract-record" + (current ? " approved-contract-current" : "")}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="approved-contract-check" aria-hidden="true">✓</span>
        <span className="approved-contract-summary-copy">
          <strong>Approved contract</strong>
          <span>{summary}</span>
        </span>
        <span className="approved-contract-view">View approved authority</span>
        <time dateTime={contract.approvedAt}>{formatDateTime(contract.approvedAt)}</time>
      </summary>
      <div className="approved-contract-body">
        <section className="approved-contract-intent">
          <span>Goal</span>
          <strong>{contract.version === 1 ? contract.goal : run.prompt}</strong>
          {contract.version === 1 && contract.plannedActions.length > 0 && (
            <ol>
              {contract.plannedActions.map((action, index) => (
                <li key={index + "-approved-" + action}>{action}</li>
              ))}
            </ol>
          )}
        </section>
        <div className="approved-authority-grid">
          <section>
            <div className="approved-authority-heading">
              <strong>Write authority</strong>
              <span>Enforced</span>
            </div>
            {writablePaths.length > 0 ? (
              <ul>{writablePaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
            ) : (
              <p>No write authority.</p>
            )}
          </section>
          <section>
            <div className="approved-authority-heading">
              <strong>Protected paths</strong>
            </div>
            {contract.protectedPaths.length > 0 ? (
              <ul>
                {contract.protectedPaths.map((path) => <li key={path}><code>{path}</code></li>)}
              </ul>
            ) : (
              <p>No explicit protected paths.</p>
            )}
          </section>
        </div>
      </div>
    </details>
  );
}

function ExecutionEvidenceCard({
  run,
  historical,
  rollingBack,
  onRollback,
}: {
  run: AgentRun;
  historical: boolean;
  rollingBack: boolean;
  onRollback: () => void;
}) {
  const executionEvents = run.events ?? [];
  const primaryExecutionEvents = executionEvents.filter(
    (event) => event.kind !== "command" || event.outcome === "failure",
  );
  const genericCommandEvents = displayableTechnicalCommandEvents(executionEvents);
  const currentTestCommandStatus = testCommandStatus(executionEvents);
  const showTestFileIntegrityWarning = hasTestFileIntegrityWarning(executionEvents);
  const workspaceMutationEvents = executionEvents.filter(
    (event) =>
      event.technical.source === "workspace-diff" &&
      ["create", "modify", "delete"].includes(event.kind),
  );
  const outcomeLabel =
    run.status === "completed"
      ? "Completed"
      : run.status === "failed"
        ? "Failed"
        : "Cancelled";

  const evidence = (
    <article className="execution-evidence">
      <div className="execution-evidence-header">
        <div>
          <span className="eyebrow">Execution evidence</span>
          <h3>What happened</h3>
        </div>
        <div className="execution-outcome-badges">
          <span className={"run-outcome run-outcome-" + run.status}>{outcomeLabel}</span>
          <span className="evidence-source">Observed record</span>
        </div>
      </div>
      {run.status === "failed" && (
        <div className="run-outcome-message run-outcome-message-failed" role="alert">
          <strong>⚠ Run failed</strong>
          {run.error && <span>{run.error}</span>}
        </div>
      )}
      {run.status === "cancelled" && (
        <div className="run-outcome-message">
          <strong>Run cancelled</strong>
        </div>
      )}
      <section className="evidence-planned">
        <div className="evidence-section-heading">
          <strong>Plan</strong>
          <span>Approved intent</span>
        </div>
        {run.executionContract?.version === 1 ? (
          <ol>
            {run.executionContract.plannedActions.map((action, index) => (
              <li key={index + "-planned-" + action}>{action}</li>
            ))}
          </ol>
        ) : (
          <p>{run.prompt}</p>
        )}
        <small>This is not proof that an action occurred.</small>
      </section>
      <section className="evidence-executed">
        <div className="evidence-section-heading">
          <strong>Executed evidence</strong>
          <span>Runtime + workspace</span>
        </div>
        {primaryExecutionEvents.length > 0 ? (
          <ol className="evidence-timeline">
            {primaryExecutionEvents.map((event) => (
              <li key={event.id} className={"evidence-event evidence-" + event.kind}>
                <span className="evidence-marker" aria-hidden="true">{eventGlyph(event)}</span>
                <div>
                  <p>{eventDescription(event)}</p>
                  {eventSupportingText(event) && (
                    <span className="evidence-supporting-text">{eventSupportingText(event)}</span>
                  )}
                  <details>
                    <summary>Technical details</summary>
                    <dl>
                      <div><dt>Source</dt><dd>{event.technical.source}</dd></div>
                      <div><dt>Item type</dt><dd>{event.technical.itemType}</dd></div>
                      {event.technical.exitCode !== undefined && (
                        <div><dt>Exit code</dt><dd>{event.technical.exitCode}</dd></div>
                      )}
                      {event.technical.command && (
                        <div><dt>Command</dt><dd><code>{event.technical.command}</code></dd></div>
                      )}
                    </dl>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="evidence-not-observed">Not observed</p>
        )}
        {genericCommandEvents.length > 0 && (
          <details className="evidence-command-log">
            <summary>Technical command evidence ({genericCommandEvents.length})</summary>
            <ol>
              {genericCommandEvents.map((event) => (
                <li key={"technical-" + event.id}>
                  {event.technical.command && <code>{event.technical.command}</code>}
                  {event.technical.exitCode !== undefined && (
                    <span>Exit code {event.technical.exitCode}</span>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
        <p className="evidence-net-state-note">
          Regular-file content changes show the resulting PRE/POST state. Transient
          writes restored before completion, symlinks, empty directories, and
          metadata-only changes are not shown.
        </p>
      </section>
      <div className="evidence-summary">
        <div>
          <span>Resulting regular-file content changes</span>
          <strong>{resultingRegularFileChangesLabel(executionEvents, run.workspaceDiffStatus)}</strong>
          {workspaceMutationEvents.length > 0 && (
            <details className="changed-file-details">
              <summary>View files</summary>
              {(["create", "modify", "delete"] as const).map((kind) => {
                const paths = workspaceMutationEvents
                  .filter((event) => event.kind === kind)
                  .map((event) => event.path)
                  .filter((value): value is string => Boolean(value));
                return paths.length > 0 ? (
                  <section key={kind}>
                    <b>{kind === "create" ? "Created" : kind === "modify" ? "Modified" : "Deleted"}</b>
                    <ul>
                      {paths.map((workspacePath) => (
                        <li key={kind + "-" + workspacePath}><code>{workspacePath}</code></li>
                      ))}
                    </ul>
                  </section>
                ) : null;
              })}
            </details>
          )}
          {run.workspaceDiffStatus === "partial" && <small>Partial manifest coverage.</small>}
        </div>
        <div>
          <span>Test execution</span>
          <strong>{currentTestCommandStatus === "Test command passed" ? "✓ " : ""}{currentTestCommandStatus}</strong>
          {showTestFileIntegrityWarning && (
            <small className="test-integrity-warning">⚠ Test files were modified during this Run</small>
          )}
        </div>
        <div>
          <span>Authority blocks</span>
          <strong>
            {executionEvents.some((event) => event.kind === "blocked")
              ? String(executionEvents.filter((event) => event.kind === "blocked").length)
              : "Not observed"}
          </strong>
        </div>
      </div>
      {run.rollback && (
        <section className="recovery-card">
          <div>
            <span className="eyebrow">Recovery</span>
            {run.rollback.status === "available" ? (
              <><strong>Pre-run snapshot available</strong><p>Restore the persistent workspace to its pre-run state.</p></>
            ) : run.rollback.status === "restored" ? (
              <><strong className="recovery-success">✓ Workspace rolled back</strong><p>Restored to its pre-run state.</p></>
            ) : run.rollback.unavailableReason === "newer_run_executed" ? (
              <><strong>Rollback unavailable</strong><p>A newer Run has already changed this workspace.</p></>
            ) : (
              <><strong>Rollback unavailable</strong><p>A complete trusted pre-run snapshot is not available.</p></>
            )}
          </div>
          {run.rollback.status === "available" && !historical && (
            <button type="button" className="button button-ghost" disabled={rollingBack} onClick={onRollback}>
              {rollingBack ? <Spinner /> : "Restore pre-run state"}
            </button>
          )}
        </section>
      )}
    </article>
  );

  return historical ? (
    <details className="historical-evidence">
      <summary>Execution evidence · {outcomeLabel}</summary>
      {evidence}
    </details>
  ) : evidence;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [writablePathInput, setWritablePathInput] = useState("");
  const [protectedPathInput, setProtectedPathInput] = useState("");
  const [negotiationInstruction, setNegotiationInstruction] = useState("");
  const [negotiatingContract, setNegotiatingContract] = useState(false);
  const [negotiationNotice, setNegotiationNotice] = useState<string | null>(null);
  const [retryingProposal, setRetryingProposal] = useState(false);
  const [proposalRetryNotice, setProposalRetryNotice] = useState<string | null>(
    null,
  );
  const [rollingBack, setRollingBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const ownedRunsByMessageId = useMemo(
    () => runsByOwnerMessageId(messages, runs),
    [messages, runs],
  );

  const rememberRun = useCallback((run: AgentRun) => {
    setActiveRun(run);
    setRuns((current) =>
      [run, ...current.filter((item) => item.id !== run.id)].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    );
  }, []);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setRuns([]);
    setWritablePathInput("");
    setProtectedPathInput("");
    setNegotiationInstruction("");
    setNegotiationNotice(null);
    setNegotiatingContract(false);
    setRetryingProposal(false);
    setProposalRetryNotice(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setRuns(result.runs);
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) rememberRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        rememberRun(result.run);
        setNegotiationInstruction("");
        setNegotiationNotice(null);
        setProposalRetryNotice(null);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const replaceProtectedPaths = async (protectedPaths: string[]) => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      negotiatingContract ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.updateExecutionContract(activeRun.id, {
        protectedPaths,
      });
      rememberRun(run);
      setProposalRetryNotice(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const replaceWritablePaths = async (writablePaths: string[]) => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      activeRun.executionContract?.version !== 1 ||
      negotiatingContract ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.updateExecutionContract(activeRun.id, {
        writablePaths,
      });
      rememberRun(run);
      setProposalRetryNotice(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const negotiateExecutionContract = async (event: React.FormEvent) => {
    event.preventDefault();
    const instruction = negotiationInstruction.trim();
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      activeRun.executionContract?.version !== 1 ||
      !instruction ||
      retryingProposal
    ) return;
    setNegotiatingContract(true);
    setNegotiationNotice(null);
    setError(null);
    try {
      const result = await api.negotiateExecutionContract(activeRun.id, instruction);
      rememberRun(result.run);
      setNegotiationNotice(result.notice);
      setProposalRetryNotice(null);
      if (result.applied) setNegotiationInstruction("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNegotiatingContract(false);
    }
  };

  const addProtectedPath = async (event: React.FormEvent) => {
    event.preventDefault();
    const protectedPath = protectedPathInput.trim();
    const currentPaths = activeRun?.executionContract?.protectedPaths;
    if (!protectedPath || !currentPaths) return;
    await replaceProtectedPaths([...currentPaths, protectedPath]);
    setProtectedPathInput("");
  };

  const addWritablePath = async (event: React.FormEvent) => {
    event.preventDefault();
    const writablePath = writablePathInput.trim();
    const contract = activeRun?.executionContract;
    if (!writablePath || contract?.version !== 1) return;
    await replaceWritablePaths([...contract.writablePaths, writablePath]);
    setWritablePathInput("");
  };

  const retryExecutionContractProposal = async () => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      activeRun.executionContract?.version !== 1 ||
      activeRun.executionContract.proposalSource !== "fallback"
    ) return;
    setRetryingProposal(true);
    setProposalRetryNotice(null);
    setError(null);
    try {
      const result = await api.retryExecutionContractProposal(activeRun.id);
      rememberRun(result.run);
      setProposalRetryNotice(result.notice);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRetryingProposal(false);
    }
  };

  const approveRun = async () => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      !selected ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.approveRun(activeRun.id);
      rememberRun(run);
      void pollRun(run.id, selected.id).catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancelPendingRun = async () => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      !selected ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.cancelRun(activeRun.id);
      rememberRun(run);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const rollbackRun = async () => {
    if (!activeRun || activeRun.rollback?.status !== "available") return;
    setRollingBack(true);
    setError(null);
    try {
      const { run } = await api.rollbackRun(activeRun.id);
      rememberRun(run);
      await refreshAgents();
    } catch (reason) {
      try {
        const { run } = await api.run(activeRun.id);
        rememberRun(run);
      } catch {
        // Preserve the current Run if it cannot be refreshed.
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRollingBack(false);
    }
  };

  const renderRunPresentation = (run: AgentRun) => {
    const current = run.id === activeRun?.id;
    if (run.status === "awaiting_approval") {
      if (!current || !run.executionContract) return null;
      const contract = run.executionContract;
      return (
        <article className="execution-contract">
          <header className="contract-header">
            <div className="contract-heading">
              <span className="eyebrow">Preflight</span>
              <h3>{contract.version === 1 ? contract.goal : run.prompt}</h3>
            </div>
            <div className="contract-badges">
              {contract.version === 1 && (
                <span className={"proposal-source proposal-source-" + contract.proposalSource}>
                  <span className="proposal-source-dot" aria-hidden="true" />
                  {contract.proposalSource === "ai" ? "AI proposal" : "Manual fallback"}
                </span>
              )}
              {contract.version === 1 && (
                <span className={"risk-level risk-level-" + contract.riskLevel}>
                  {contract.riskLevel} risk
                </span>
              )}
              <span className="contract-status">
                <span className="contract-status-dot" aria-hidden="true" />
                Awaiting approval
              </span>
            </div>
          </header>
          {contract.version === 1 ? (
            <>
              {contract.proposalSource === "fallback" && (
                <section className="contract-fallback">
                  <div>
                    <strong>AI proposal unavailable.</strong>
                    <p>Configure authority manually or retry.</p>
                  </div>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={busy || negotiatingContract || retryingProposal}
                    onClick={() => void retryExecutionContractProposal()}
                  >
                    {retryingProposal ? <Spinner /> : "Retry AI proposal"}
                  </button>
                  {retryingProposal && (
                    <span className="contract-planning-state" role="status">
                      Planning only—Codex is not running.
                    </span>
                  )}
                </section>
              )}
              {proposalRetryNotice && (
                <p className="contract-negotiation-notice" role="status">{proposalRetryNotice}</p>
              )}
              <section className="contract-plan">
                <div className="contract-section-heading"><strong>Plan</strong></div>
                {contract.plannedActions.length > 0 ? (
                  <ol>
                    {contract.plannedActions.map((action, index) => (
                      <li key={index + "-" + action}>{action}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="contract-empty">No actions proposed.</p>
                )}
                {contract.rationale && (
                  <details className="contract-rationale">
                    <summary>Why this scope?</summary>
                    <p>{contract.rationale}</p>
                  </details>
                )}
              </section>
              <div className="contract-authority-grid">
                <AuthorityPathSection
                  title="Write authority"
                  tone="writable"
                  paths={contract.writablePaths}
                  emptyText="No write authority. The workspace remains read-only."
                  description="Everything outside these scopes is read-only."
                  addLabel="Add writable scope"
                  placeholder="Workspace path, e.g. src/**"
                  inputValue={writablePathInput}
                  disabled={busy || negotiatingContract || retryingProposal}
                  enforced
                  onInputChange={setWritablePathInput}
                  onSubmit={addWritablePath}
                  onRemove={(writablePath) =>
                    void replaceWritablePaths(
                      contract.writablePaths.filter((item) => item !== writablePath),
                    )
                  }
                />
                <AuthorityPathSection
                  title="Protected"
                  tone="protected"
                  paths={contract.protectedPaths}
                  emptyText="No explicit protected paths."
                  description="Protected paths override writable scopes."
                  addLabel="Protect path"
                  placeholder="Workspace-relative path"
                  inputValue={protectedPathInput}
                  disabled={busy || negotiatingContract || retryingProposal}
                  collapseAfter={3}
                  onInputChange={setProtectedPathInput}
                  onSubmit={addProtectedPath}
                  onRemove={(protectedPath) =>
                    void replaceProtectedPaths(
                      contract.protectedPaths.filter((item) => item !== protectedPath),
                    )
                  }
                />
              </div>
              <p className="contract-scope-note">
                Directory scopes end in <code>/**</code>; exact-file scopes do not authorize sibling files.
              </p>
              <form className="contract-negotiation" onSubmit={negotiateExecutionContract}>
                <label htmlFor="contract-negotiation-input">Adjust this plan</label>
                <div className="contract-negotiation-row">
                  <textarea
                    id="contract-negotiation-input"
                    value={negotiationInstruction}
                    onChange={(event) => setNegotiationInstruction(event.target.value)}
                    placeholder="Tell Anti-Ultron what you want changed…"
                    rows={2}
                    maxLength={5_000}
                    disabled={busy || negotiatingContract || retryingProposal}
                  />
                  <button
                    type="submit"
                    className="button button-ghost"
                    disabled={
                      busy || negotiatingContract || retryingProposal || !negotiationInstruction.trim()
                    }
                  >
                    Update plan
                  </button>
                </div>
                {negotiatingContract && (
                  <div className="contract-updating" role="status">
                    <span className="contract-updating-dot" aria-hidden="true" />
                    <span><strong>Updating contract…</strong> Codex is not running.</span>
                  </div>
                )}
                {negotiationNotice && (
                  <p className="contract-negotiation-notice" role="status">{negotiationNotice}</p>
                )}
              </form>
            </>
          ) : (
            <AuthorityPathSection
              title="Protected"
              tone="protected"
              paths={contract.protectedPaths}
              emptyText="No explicit protected paths."
              description="Protected paths override writable scopes."
              addLabel="Protect path"
              placeholder="Workspace-relative path"
              inputValue={protectedPathInput}
              disabled={busy || negotiatingContract || retryingProposal}
              collapseAfter={3}
              onInputChange={setProtectedPathInput}
              onSubmit={addProtectedPath}
              onRemove={(protectedPath) =>
                void replaceProtectedPaths(
                  contract.protectedPaths.filter((item) => item !== protectedPath),
                )
              }
            />
          )}
          <div className="contract-actions">
            <button
              type="button"
              className="button button-ghost"
              disabled={busy || negotiatingContract || retryingProposal}
              onClick={() => void cancelPendingRun()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || negotiatingContract || retryingProposal}
              onClick={() => void approveRun()}
            >
              {busy ? <Spinner /> : "Approve & Run"}
            </button>
          </div>
        </article>
      );
    }

    return (
      <>
        <ApprovedContractRecord run={run} current={current} />
        {current && ["queued", "running"].includes(run.status) && (
          <article className="runtime-progress">
            <span className="eyebrow">Execution</span>
            <div>
              <Spinner />
              <div>
                <strong>{run.status === "queued" ? "Preparing approved Run" : "Codex is running"}</strong>
                <p>
                  {run.status === "queued"
                    ? "The approved authority is being prepared."
                    : "Reading, editing, or running commands in the approved workspace."}
                </p>
              </div>
            </div>
          </article>
        )}
        {["completed", "failed", "cancelled"].includes(run.status) && (
          <ExecutionEvidenceCard
            run={run}
            historical={!current}
            rollingBack={rollingBack}
            onRollback={() => void rollbackRun()}
          />
        )}
      </>
    );
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>Protected by Anti-Ultron</span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill
                    status={selected.status}
                    label={
                      activeRun?.status === "awaiting_approval"
                        ? "Awaiting approval"
                        : undefined
                    }
                  />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Anti-Ultron control plane</span>
                  <h2>Plan, approve, execute</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      Describe the task. Anti-Ultron proposes workspace authority for your
                      review before Codex runs.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => {
                    const ownedRun = ownedRunsByMessageId.get(message.id);
                    return (
                      <Fragment key={message.id}>
                        <article className={"message message-" + message.role}>
                          <div className="message-meta">
                            <strong>{message.role === "user" ? "You" : selected.name}</strong>
                            <span>{formatTime(message.createdAt)}</span>
                          </div>
                          <div className="message-body">{message.content}</div>
                        </article>
                        {ownedRun && renderRunPresentation(ownedRun)}
                      </Fragment>
                    );
                  })
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null &&
                    ["awaiting_approval", "queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null &&
                        ["awaiting_approval", "queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
