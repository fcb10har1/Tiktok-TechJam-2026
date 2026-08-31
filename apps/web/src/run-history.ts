import type { Message } from "./types";

type RunIdentity = { id: string };
type MessageRunReference = Pick<Message, "id" | "runId" | "role">;

/**
 * Associates each Run with its first chronological user message exactly once.
 * The returned map is keyed by message ID for direct conversation rendering.
 */
export function runsByOwnerMessageId<Run extends RunIdentity>(
  messages: readonly MessageRunReference[],
  runs: readonly Run[],
): Map<string, Run> {
  const runsById = new Map<string, Run>();
  for (const run of runs) {
    // The API returns newest-first. Preserve the first instance defensively if
    // active and historical state ever contain the same Run during a refresh.
    if (!runsById.has(run.id)) runsById.set(run.id, run);
  }
  const claimedRunIds = new Set<string>();
  const ownedRuns = new Map<string, Run>();
  for (const message of messages) {
    if (message.role !== "user" || claimedRunIds.has(message.runId)) continue;
    const run = runsById.get(message.runId);
    if (!run) continue;
    claimedRunIds.add(message.runId);
    ownedRuns.set(message.id, run);
  }
  return ownedRuns;
}
