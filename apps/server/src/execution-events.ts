import { existsSync } from "node:fs";
import path from "node:path";
import { isPathInsideScope } from "./protected-paths.js";
import type { RunEvent, RunnerRequest } from "./types.js";

type CommandItem = {
  id?: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code: number | null;
  status: string;
};

type WriteKind = "write" | "delete";

interface CommandTarget {
  path: string;
  writeKind: WriteKind;
  deterministic: boolean;
}

interface StartedCommand {
  target: CommandTarget | null;
  targetExisted: boolean | null;
}

const PERMISSION_FAILURE =
  /(?:read-only file system|\bEROFS\b|permission denied|\bEACCES\b)/i;
const SECRET_BEARING_COMMAND =
  /(?:authorization|bearer\s|api[_-]?key|access[_-]?token|password|passwd|--header|(?:^|\s)-H\s|\bsecret\b|\$\(|`)/i;
const WORKSPACE_PATH = /^[A-Za-z0-9._@+,-]+(?:\/[A-Za-z0-9._@+,-]+)*$/;

function commandItem(value: unknown): CommandItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    item.type !== "command_execution" ||
    typeof item.command !== "string" ||
    typeof item.aggregated_output !== "string" ||
    !(typeof item.exit_code === "number" || item.exit_code === null) ||
    typeof item.status !== "string"
  ) {
    return null;
  }
  return {
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    type: "command_execution",
    command: item.command,
    aggregated_output: item.aggregated_output,
    exit_code: item.exit_code,
    status: item.status,
  };
}

function workspaceRelativePath(candidate: string): string | null {
  let relative = candidate.trim().replace(/^["']|["']$/g, "");
  if (relative.startsWith("/workspace/")) relative = relative.slice(11);
  else if (relative === "/workspace") return null;
  else if (path.posix.isAbsolute(relative)) return null;
  relative = relative.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!relative || !WORKSPACE_PATH.test(relative)) return null;
  const normalized = path.posix.normalize(relative);
  if (normalized === "." || normalized.startsWith("../")) return null;
  return normalized;
}

function commandBody(command: string): string {
  const match = command.match(/^(?:\/bin\/)?(?:ba|z|)sh\s+-lc\s+([\s\S]+)$/);
  if (!match) return command.trim();
  const value = match[1]!.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function writeTarget(command: string): CommandTarget | null {
  const body = commandBody(command);
  const withoutSafeMkdir = body.replace(
    /^mkdir\s+-p\s+[A-Za-z0-9._@+/,=-]+\s+&&\s+/,
    "",
  );
  const deterministic = !/(?:\|\||&&|;|(?<!\|)\|(?!\|))/.test(withoutSafeMkdir);
  const redirection = body.match(/(?:^|\s)(?:>|>>)\s*["']?([^\s"';&|]+)["']?/);
  if (redirection) {
    const relative = workspaceRelativePath(redirection[1]!);
    if (relative) return { path: relative, writeKind: "write", deterministic };
  }

  const nodeWrite = body.match(
    /(?:writeFileSync|appendFileSync|unlinkSync|renameSync)\(\s*["']([^"']+)["']/,
  );
  if (nodeWrite) {
    const relative = workspaceRelativePath(nodeWrite[1]!);
    if (relative) {
      return {
        path: relative,
        writeKind: /unlinkSync/.test(body) ? "delete" : "write",
        deterministic,
      };
    }
  }

  const pythonWrite = body.match(
    /open\(\s*["']([^"']+)["']\s*,\s*["'](?:w|a|x|w\+|a\+)["']/,
  );
  if (pythonWrite) {
    const relative = workspaceRelativePath(pythonWrite[1]!);
    if (relative) return { path: relative, writeKind: "write", deterministic };
  }

  const remove = body.match(/(?:^|[;&|]\s*)rm\s+(?:-[A-Za-z]+\s+)*["']?([^\s"';&|]+)["']?\s*$/);
  if (remove) {
    const relative = workspaceRelativePath(remove[1]!);
    if (relative) return { path: relative, writeKind: "delete", deterministic };
  }
  return null;
}

function inspectedPath(command: string): string | null {
  const body = commandBody(command);
  const match = body.match(
    /^(?:cat|head|tail)\s+(?:-[A-Za-z0-9=-]+\s+)*["']?([^\s"';&|]+)["']?$/,
  );
  return match ? workspaceRelativePath(match[1]!) : null;
}

function isVerificationCommand(command: string): boolean {
  const body = commandBody(command);
  return /^(?:npm\s+(?:test|run\s+test(?::[^\s]+)?)|pnpm\s+(?:test|run\s+test)|yarn\s+test|npx\s+vitest|vitest|pytest|python(?:3)?\s+-m\s+pytest|node\s+--test|cargo\s+test)(?:\s|$)/.test(
    body,
  );
}

function sanitizedCommand(command: string): string | undefined {
  const trimmed = command.trim();
  const body = commandBody(trimmed);
  if (
    !trimmed ||
    trimmed.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    /[;&|><]/.test(body) ||
    SECRET_BEARING_COMMAND.test(trimmed) ||
    /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=\S+/.test(trimmed)
  ) {
    return undefined;
  }
  if (writeTarget(trimmed)) return undefined;
  if (
    isVerificationCommand(trimmed) ||
    /^(?:pwd|git\s+(?:status|diff)(?:\s+--[A-Za-z-]+)*|ls(?:\s+(?:-[A-Za-z]+|[A-Za-z0-9._@+/,=-]+))*)$/.test(
      body,
    ) ||
    inspectedPath(trimmed)
  ) {
    return trimmed;
  }
  return undefined;
}

function isExplicitlyProtected(request: RunnerRequest, target: string): boolean {
  return request.protectedPaths.some((scope) => isPathInsideScope(target, scope));
}

function isWritable(request: RunnerRequest, target: string): boolean {
  if (isExplicitlyProtected(request, target)) return false;
  return request.authorityPlan.writableMounts.some(
    (mount) =>
      target === mount.path ||
      (mount.kind === "directory" && target.startsWith(mount.path + "/")),
  );
}

function outputAttributesTarget(output: string, target: string): boolean {
  return output.includes(target) || output.includes("/workspace/" + target);
}

function technical(item: CommandItem): RunEvent["technical"] {
  const command = sanitizedCommand(item.command);
  return {
    source: "codex-jsonl",
    itemType: "command_execution",
    ...(item.id ? { itemId: item.id } : {}),
    ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
    ...(command ? { command } : {}),
  };
}

export class ExecutionEventCollector {
  private readonly started = new Map<string, StartedCommand>();
  private readonly collected: RunEvent[] = [];
  private nextSequence = 1;

  constructor(
    private readonly request: RunnerRequest,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  consume(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type !== "item.started" && event.type !== "item.completed") return;
    const item = commandItem(event.item);
    if (!item) return;

    const itemKey = item.id ?? "anonymous";
    if (event.type === "item.started") {
      const target = writeTarget(item.command);
      this.started.set(itemKey, {
        target,
        targetExisted: target
          ? existsSync(path.join(this.request.workspacePath, target.path))
          : null,
      });
      return;
    }
    if (item.exit_code === null || !["completed", "failed"].includes(item.status)) {
      return;
    }

    const started = this.started.get(itemKey);
    const target = started?.target ?? writeTarget(item.command);
    const failed = item.exit_code !== 0 || item.status === "failed";
    const base = {
      id: item.id ? "codex-" + item.id : "codex-event-" + this.nextSequence,
      sequence: this.nextSequence++,
      timestamp: this.clock(),
      technical: technical(item),
    };

    if (
      failed &&
      target &&
      target.deterministic &&
      PERMISSION_FAILURE.test(item.aggregated_output) &&
      outputAttributesTarget(item.aggregated_output, target.path) &&
      !isWritable(this.request, target.path)
    ) {
      this.collected.push({
        ...base,
        kind: "blocked",
        outcome: "blocked",
        path: target.path,
        authorityReason: isExplicitlyProtected(this.request, target.path)
          ? "explicitly_protected"
          : "outside_write_authority",
      });
      return;
    }

    if (isVerificationCommand(item.command)) {
      this.collected.push({
        ...base,
        kind: "verify",
        outcome: failed ? "failure" : "success",
      });
      return;
    }

    const inspected = inspectedPath(item.command);
    if (inspected && !failed) {
      this.collected.push({
        ...base,
        kind: "inspect",
        outcome: "success",
        path: inspected,
      });
      return;
    }

    if (
      target?.deterministic &&
      !failed &&
      !PERMISSION_FAILURE.test(item.aggregated_output) &&
      (target.writeKind !== "delete" || started?.targetExisted === true)
    ) {
      this.collected.push({
        ...base,
        kind:
          target.writeKind === "delete"
            ? "delete"
            : started?.targetExisted
              ? "modify"
              : "create",
        outcome: "success",
        path: target.path,
      });
      return;
    }

    if (PERMISSION_FAILURE.test(item.aggregated_output)) {
      this.collected.push({
        ...base,
        kind: "warning",
        ...(target ? { path: target.path } : {}),
      });
      return;
    }

    this.collected.push({
      ...base,
      kind: "command",
      outcome: failed ? "failure" : "success",
    });
  }

  events(): RunEvent[] {
    const result: RunEvent[] = [];
    for (const event of this.collected) {
      const previous = result.at(-1);
      if (
        previous &&
        event.kind === "inspect" &&
        previous.kind === "inspect" &&
        event.path === previous.path
      ) {
        continue;
      }
      if (
        previous &&
        event.kind === "modify" &&
        previous.kind === "create" &&
        event.path === previous.path
      ) {
        continue;
      }
      result.push({ ...event, sequence: result.length + 1 });
    }
    return result;
  }
}

export function verificationSummary(
  events: readonly RunEvent[],
): "Passed" | "Failed" | "Not observed" {
  const verifications = events.filter((event) => event.kind === "verify");
  if (verifications.length === 0) return "Not observed";
  return verifications.some((event) => event.outcome === "failure")
    ? "Failed"
    : "Passed";
}
