// Pure builders for T3 orchestration-protocol-2 commands and the read-side
// summaries the MCP tools return. Schemas were read from the installed T3
// binary (`strings <t3> | grep OrchestrationV2Command`) at
// 0.0.46-nightly.20261013; the run-selection rules mirror T3's own
// ThreadManagementService so a peer message lands the way a local
// t3_thread_send would.

export type IdFactory = () => string;

export interface ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection?: ModelSelection | null;
  deletedAt?: string | null;
}

export interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  status: string;
  updatedAt?: string;
  createdAt?: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  settledOverride?: string | null;
  activeRunId?: string | null;
  latestRunId?: string | null;
  modelSelection?: ModelSelection;
  branch?: string | null;
  worktreePath?: string | null;
  pendingRuntimeRequest?: unknown;
  latestVisibleMessage?: unknown;
}

export interface ShellSnapshot {
  projects: ProjectShell[];
  threads: ThreadShell[];
}

export interface ProjectionRun {
  id: string;
  ordinal: number;
  status: string;
  activeAttemptId: string | null;
}

export interface ProjectionMessage {
  role: string;
  text: string;
  createdAt: string;
}

export interface Projection {
  thread: { id: string; title: string; projectId: string } & Record<string, unknown>;
  runs: ProjectionRun[];
  providerTurns: { runAttemptId: string; status: string }[];
  messages: ProjectionMessage[];
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: unknown;
}

export type WorkspaceStrategy =
  | { type: "root" }
  | { type: "existing_worktree"; worktreePath: string; branch?: string }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };

export type SendMode = "auto" | "queue" | "steer" | "restart";

const TERMINAL_RUN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

export class NoSteerableRunError extends Error {
  constructor(threadId: string) {
    super(`Thread ${threadId} has no running turn to steer or restart`);
    this.name = "NoSteerableRunError";
  }
}

const newestFirst = (left: ProjectionRun, right: ProjectionRun) => right.ordinal - left.ordinal;

export function selectSteerableRun(projection: Projection): ProjectionRun | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running"),
    )
    .sort(newestFirst)[0];
}

export function selectActiveRun(projection: Projection): ProjectionRun | undefined {
  return projection.runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).sort(newestFirst)[0];
}

export function buildMessageDispatch(input: {
  projection: Projection;
  text: string;
  mode: SendMode;
  newId: IdFactory;
}) {
  const { projection, text, mode, newId } = input;
  const steerable = selectSteerableRun(projection);
  let dispatchMode: Record<string, string>;
  if (mode === "steer" || mode === "restart") {
    if (steerable === undefined) throw new NoSteerableRunError(projection.thread.id);
    dispatchMode = { type: mode === "steer" ? "steer_active" : "restart_active", targetRunId: steerable.id };
  } else if (mode === "auto" && steerable !== undefined) {
    dispatchMode = { type: "steer_active", targetRunId: steerable.id };
  } else {
    dispatchMode = { type: mode === "queue" ? "queue_after_active" : "start_immediately" };
  }
  return {
    type: "message.dispatch" as const,
    commandId: newId(),
    messageId: newId(),
    threadId: projection.thread.id,
    text,
    attachments: [],
    dispatchMode,
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
  };
}

export function buildRunInterrupt(input: { projection: Projection; newId: IdFactory }) {
  const run = selectActiveRun(input.projection);
  if (run === undefined) return null;
  return {
    type: "run.interrupt" as const,
    commandId: input.newId(),
    threadId: input.projection.thread.id,
    runId: run.id,
    reason: "Interrupted by a peer T3 environment",
  };
}

export type ThreadCommandType = "thread.archive" | "thread.unarchive" | "thread.settle" | "thread.unsettle";

export function buildThreadCommand(type: ThreadCommandType, threadId: string, newId: IdFactory) {
  return { type, commandId: newId(), threadId };
}

export function buildLaunch(input: {
  projectId: string;
  title: string;
  text: string;
  modelSelection: ModelSelection;
  workspaceStrategy: WorkspaceStrategy;
  newId: IdFactory;
}) {
  return {
    commandId: input.newId(),
    threadId: input.newId(),
    creationSource: "mcp" as const,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspaceStrategy,
    initialMessage: { messageId: input.newId(), text: input.text, attachments: [] },
  };
}

const normalisePath = (path: string) => path.replace(/\/+$/, "");
const isLive = (record: { deletedAt?: string | null }) => !record.deletedAt;

export function resolveProject(shell: ShellSnapshot, workspaceRoot: string): ProjectShell | undefined {
  const wanted = normalisePath(workspaceRoot);
  return shell.projects.find((project) => isLive(project) && normalisePath(project.workspaceRoot) === wanted);
}

export function filterThreads(
  shell: ShellSnapshot,
  filter: { projectId?: string; titleContains?: string; statuses?: string[]; limit?: number },
): ThreadShell[] {
  const needle = filter.titleContains?.toLowerCase();
  return shell.threads
    .filter(isLive)
    .filter((thread) => filter.projectId === undefined || thread.projectId === filter.projectId)
    .filter((thread) => needle === undefined || thread.title.toLowerCase().includes(needle))
    .filter((thread) => filter.statuses === undefined || filter.statuses.includes(thread.status))
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
}

export function summarizeProjection(projection: Projection, lastMessages: number) {
  return {
    thread: projection.thread,
    activeRunId: selectActiveRun(projection)?.id ?? null,
    steerableRunId: selectSteerableRun(projection)?.id ?? null,
    totalMessages: projection.messages.length,
    messages: projection.messages
      .slice(-lastMessages)
      .map(({ role, text, createdAt }) => ({ role, text, createdAt })),
  };
}
