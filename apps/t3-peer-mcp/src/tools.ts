import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildLaunch,
  buildMessageDispatch,
  buildRunInterrupt,
  buildThreadCommand,
  filterThreads,
  resolveProject,
  summarizeProjection,
  type ModelSelection,
  type ShellSnapshot,
  type ThreadShell,
  type WorkspaceStrategy,
} from "./commands.js";
import type { T3Client } from "./t3-client.js";

export interface PeerHandle {
  name: string;
  client(): Promise<T3Client>;
}

export interface PeerRegistry {
  self: string;
  peers: PeerHandle[];
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_MODEL: ModelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const THREAD_STATUSES = [
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
] as const;

export function resolvePeer(registry: PeerRegistry, name: string | undefined): PeerHandle {
  if (name === undefined) {
    if (registry.peers.length === 1) return registry.peers[0]!;
    throw new Error(`Several peers are configured; pass peer as one of: ${registry.peers.map((p) => p.name).join(", ")}`);
  }
  const peer = registry.peers.find((candidate) => candidate.name === name);
  if (peer === undefined) {
    throw new Error(`Unknown peer "${name}". Configured: ${registry.peers.map((p) => p.name).join(", ")}`);
  }
  return peer;
}

/**
 * Tells the receiving agent the message came from another environment, not its user.
 * A trailer, not a header: T3 names a thread's scratch directory and seeds its title
 * from the start of the first message.
 */
export function stampMessage(self: string, text: string): string {
  return `${text}\n\n[Sent via t3-peer from the ${self} T3 environment]`;
}

export function pickModel(shell: ShellSnapshot, projectId: string): ModelSelection {
  const project = shell.projects.find((candidate) => candidate.id === projectId);
  if (project?.defaultModelSelection) return project.defaultModelSelection;
  const recent = filterThreads(shell, {}).find((thread) => thread.modelSelection);
  return recent?.modelSelection ?? DEFAULT_MODEL;
}

function compactThread(thread: ThreadShell, projectTitles: Map<string, string>) {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    project: projectTitles.get(thread.projectId) ?? thread.projectId,
    updatedAt: thread.updatedAt,
    archived: Boolean(thread.archivedAt),
    settled: thread.settledOverride === "settled",
    branch: thread.branch ?? null,
    model: thread.modelSelection?.model,
    waitingOnUser: Boolean(thread.pendingRuntimeRequest),
  };
}

const json = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    // fetch() reports every network failure as "fetch failed"; the reason is in cause.
    const cause = (error as Error).cause as Error | undefined;
    const text = cause?.message ? `${(error as Error).message}: ${cause.message}` : (error as Error).message;
    return { content: [{ type: "text", text }], isError: true };
  }
}

const peerParam = z
  .string()
  .optional()
  .describe("Peer environment name from peers.json. Optional when only one peer is configured.");

export function createServer(registry: PeerRegistry): McpServer {
  const server = new McpServer({ name: "argus-t3-peer-mcp", version: "0.1.0" });
  const newId = () => randomUUID();
  const peerNames = registry.peers.map((peer) => peer.name).join(", ");

  server.registerTool(
    "peer_projects",
    {
      title: "List a peer's T3 projects",
      description: `List the live T3 projects (name and workspace root) on a peer T3 environment (${peerNames}). Workspace roots are the peer's own paths.`,
      inputSchema: z.object({ peer: peerParam }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ peer }) =>
      guarded(async () => {
        const shell = await (await resolvePeer(registry, peer).client()).getShell();
        return json(
          shell.projects
            .filter((project) => !project.deletedAt)
            .map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })),
        );
      }),
  );

  server.registerTool(
    "peer_thread_list",
    {
      title: "List a peer's T3 threads",
      description: `List threads on a peer T3 environment (${peerNames}), most recently updated first. Archived threads are excluded unless includeArchived is set.`,
      inputSchema: z.object({
        peer: peerParam,
        projectRoot: z.string().optional().describe("Only threads in the project with this workspace root (peer path)"),
        titleContains: z.string().optional(),
        statuses: z.array(z.enum(THREAD_STATUSES)).optional(),
        includeArchived: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ peer, projectRoot, titleContains, statuses, includeArchived, limit }) =>
      guarded(async () => {
        const client = await resolvePeer(registry, peer).client();
        const shell = await client.getShell();
        const archived = includeArchived ? await client.getArchivedThreads() : [];
        const pool: ShellSnapshot = { ...shell, threads: [...shell.threads, ...archived] };
        let projectId: string | undefined;
        if (projectRoot !== undefined) {
          projectId = resolveProject(shell, projectRoot)?.id;
          if (projectId === undefined) throw new Error(`No live project with workspace root ${projectRoot}`);
        }
        const titles = new Map(shell.projects.map((project) => [project.id, project.title]));
        const threads = filterThreads(pool, { projectId, titleContains, statuses, limit });
        return json(threads.map((thread) => compactThread(thread, titles)));
      }),
  );

  server.registerTool(
    "peer_thread_read",
    {
      title: "Read a peer's T3 thread",
      description:
        "Read one thread on a peer T3 environment: its status, the active run, and the last N conversation messages.",
      inputSchema: z.object({
        peer: peerParam,
        threadId: z.string(),
        lastMessages: z.number().int().min(1).max(100).default(10),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ peer, threadId, lastMessages }) =>
      guarded(async () => {
        const client = await resolvePeer(registry, peer).client();
        // The projection has the conversation but no live status; the shell has the status.
        const [projection, shell] = await Promise.all([client.getProjection(threadId), client.getShell()]);
        const summary = summarizeProjection(projection, lastMessages);
        const thread = summary.thread as Record<string, unknown>;
        const shellThread = shell.threads.find((candidate) => candidate.id === threadId);
        return json({
          ...summary,
          thread: {
            id: thread.id,
            title: thread.title,
            status: shellThread?.status ?? "archived",
            projectId: thread.projectId,
            branch: thread.branch ?? null,
            worktreePath: thread.worktreePath ?? null,
            archivedAt: thread.archivedAt ?? null,
            pendingRuntimeRequest: shellThread?.pendingRuntimeRequest ?? null,
          },
        });
      }),
  );

  server.registerTool(
    "peer_thread_send",
    {
      title: "Message a peer's T3 thread",
      description: `Send a message to a thread on a peer T3 environment. mode='auto' starts an idle thread or steers a running turn; 'queue' runs it as a separate turn after the active one; 'steer' updates the running turn; 'restart' interrupts and restarts it. A trailing line is added saying it came from the ${registry.self} environment.`,
      inputSchema: z.object({
        peer: peerParam,
        threadId: z.string(),
        text: z.string().min(1),
        mode: z.enum(["auto", "queue", "steer", "restart"]).default("auto"),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ peer, threadId, text, mode }) =>
      guarded(async () => {
        const client = await resolvePeer(registry, peer).client();
        const projection = await client.getProjection(threadId);
        const command = buildMessageDispatch({ projection, text: stampMessage(registry.self, text), mode, newId });
        await client.dispatchCommand(command);
        return json({ sent: true, threadId, messageId: command.messageId, dispatchMode: command.dispatchMode });
      }),
  );

  server.registerTool(
    "peer_thread_launch",
    {
      title: "Start a thread on a peer's T3",
      description:
        "Create a thread in a project on a peer T3 environment and start its first turn with the given prompt. The thread runs in full-access mode with nobody watching, so the prompt must carry every guardrail and all context it needs. Never put secrets in it: prompts persist in T3's database.",
      inputSchema: z.object({
        peer: peerParam,
        projectRoot: z.string().describe("Workspace root of the target project, as a path on the peer"),
        title: z.string().min(1),
        text: z.string().min(1).describe("The first-turn prompt"),
        model: z
          .object({ instanceId: z.string(), model: z.string() })
          .optional()
          .describe("Defaults to the project's default model, else the peer's most recently used one"),
        worktree: z
          .object({ branch: z.string(), baseRef: z.string(), startFromOrigin: z.boolean().default(true) })
          .optional()
          .describe("Launch into a new worktree on this branch instead of the project's main checkout"),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ peer, projectRoot, title, text, model, worktree }) =>
      guarded(async () => {
        const client = await resolvePeer(registry, peer).client();
        const shell = await client.getShell();
        const project = resolveProject(shell, projectRoot);
        if (project === undefined) throw new Error(`No live project with workspace root ${projectRoot}`);
        const workspaceStrategy: WorkspaceStrategy = worktree ? { type: "worktree", ...worktree } : { type: "root" };
        const launch = buildLaunch({
          projectId: project.id,
          title,
          text: stampMessage(registry.self, text),
          modelSelection: model ?? pickModel(shell, project.id),
          workspaceStrategy,
          newId,
        });
        await client.launchThread(launch);
        return json({ launched: true, threadId: launch.threadId, project: project.title, model: launch.modelSelection });
      }),
  );

  server.registerTool(
    "peer_thread_interrupt",
    {
      title: "Interrupt a peer's T3 thread",
      description: "Interrupt the active run of a thread on a peer T3 environment. Does nothing if no run is active.",
      inputSchema: z.object({ peer: peerParam, threadId: z.string() }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ peer, threadId }) =>
      guarded(async () => {
        const client = await resolvePeer(registry, peer).client();
        const command = buildRunInterrupt({ projection: await client.getProjection(threadId), newId });
        if (command === null) return json({ interrupted: false, reason: "no active run" });
        await client.dispatchCommand(command);
        return json({ interrupted: true, runId: command.runId });
      }),
  );

  server.registerTool(
    "peer_thread_organize",
    {
      title: "Archive or settle a peer's T3 thread",
      description: "Archive, unarchive, settle or unsettle a thread on a peer T3 environment.",
      inputSchema: z.object({
        peer: peerParam,
        threadId: z.string(),
        action: z.enum(["archive", "unarchive", "settle", "unsettle"]),
      }),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ peer, threadId, action }) =>
      guarded(async () => {
        const client = await resolvePeer(registry, peer).client();
        await client.dispatchCommand(buildThreadCommand(`thread.${action}`, threadId, newId));
        return json({ done: true, threadId, action });
      }),
  );

  return server;
}
