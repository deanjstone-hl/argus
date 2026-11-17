import { describe, expect, it } from "vitest";
import {
  buildLaunch,
  buildMessageDispatch,
  buildRunInterrupt,
  buildThreadCommand,
  filterThreads,
  NoSteerableRunError,
  resolveProject,
  summarizeProjection,
  type Projection,
  type ShellSnapshot,
} from "../src/commands.js";

const sequentialIds = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const idleProjection: Projection = {
  thread: { id: "t1", title: "Idle thread", projectId: "p1" },
  runs: [{ id: "run-1", ordinal: 1, status: "completed", activeAttemptId: null }],
  providerTurns: [],
  messages: [],
};

const runningProjection: Projection = {
  thread: { id: "t1", title: "Busy thread", projectId: "p1" },
  runs: [
    { id: "run-1", ordinal: 1, status: "completed", activeAttemptId: null },
    { id: "run-2", ordinal: 2, status: "running", activeAttemptId: "attempt-2" },
  ],
  providerTurns: [{ runAttemptId: "attempt-2", status: "running" }],
  messages: [],
};

describe("buildMessageDispatch", () => {
  it("starts an idle thread immediately in auto mode", () => {
    const command = buildMessageDispatch({
      projection: idleProjection,
      text: "hello",
      mode: "auto",
      newId: sequentialIds(),
    });
    expect(command).toEqual({
      type: "message.dispatch",
      commandId: "id-1",
      messageId: "id-2",
      threadId: "t1",
      text: "hello",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "mcp",
    });
  });

  it("steers the running turn in auto mode", () => {
    const command = buildMessageDispatch({
      projection: runningProjection,
      text: "update",
      mode: "auto",
      newId: sequentialIds(),
    });
    expect(command.dispatchMode).toEqual({ type: "steer_active", targetRunId: "run-2" });
  });

  it("queues behind the active turn in queue mode", () => {
    const command = buildMessageDispatch({
      projection: runningProjection,
      text: "later",
      mode: "queue",
      newId: sequentialIds(),
    });
    expect(command.dispatchMode).toEqual({ type: "queue_after_active" });
  });

  it("restarts the running turn in restart mode", () => {
    const command = buildMessageDispatch({
      projection: runningProjection,
      text: "redo",
      mode: "restart",
      newId: sequentialIds(),
    });
    expect(command.dispatchMode).toEqual({ type: "restart_active", targetRunId: "run-2" });
  });

  it("refuses steer when no turn is running", () => {
    expect(() =>
      buildMessageDispatch({ projection: idleProjection, text: "x", mode: "steer", newId: sequentialIds() }),
    ).toThrow(NoSteerableRunError);
  });

  it("does not treat a running run whose provider turn has ended as steerable", () => {
    const projection: Projection = {
      ...runningProjection,
      providerTurns: [{ runAttemptId: "attempt-2", status: "completed" }],
    };
    const command = buildMessageDispatch({ projection, text: "x", mode: "auto", newId: sequentialIds() });
    expect(command.dispatchMode).toEqual({ type: "start_immediately" });
  });
});

describe("buildRunInterrupt", () => {
  it("targets the newest non-terminal run", () => {
    expect(buildRunInterrupt({ projection: runningProjection, newId: sequentialIds() })).toEqual({
      type: "run.interrupt",
      commandId: "id-1",
      threadId: "t1",
      runId: "run-2",
      reason: "Interrupted by a peer T3 environment",
    });
  });

  it("returns null when nothing is running", () => {
    expect(buildRunInterrupt({ projection: idleProjection, newId: sequentialIds() })).toBeNull();
  });
});

describe("buildThreadCommand", () => {
  it("builds an archive command", () => {
    expect(buildThreadCommand("thread.archive", "t1", sequentialIds())).toEqual({
      type: "thread.archive",
      commandId: "id-1",
      threadId: "t1",
    });
  });
});

describe("buildLaunch", () => {
  it("creates the thread and its first turn in one command", () => {
    expect(
      buildLaunch({
        projectId: "p1",
        title: "Do the thing",
        text: "Please do the thing",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        workspaceStrategy: { type: "root" },
        newId: sequentialIds(),
      }),
    ).toEqual({
      commandId: "id-1",
      threadId: "id-2",
      creationSource: "mcp",
      projectId: "p1",
      title: "Do the thing",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: "id-3", text: "Please do the thing", attachments: [] },
    });
  });
});

const shell: ShellSnapshot = {
  projects: [
    { id: "p1", title: "argus", workspaceRoot: "/home/srvr/repos/argus" },
    { id: "p2", title: "old", workspaceRoot: "/home/srvr/repos/old", deletedAt: "2026-01-01T00:00:00Z" },
  ],
  threads: [
    { id: "a", projectId: "p1", title: "Fix CI", status: "running", updatedAt: "2026-10-14T02:00:00Z" },
    { id: "b", projectId: "p1", title: "Write docs", status: "idle", updatedAt: "2026-10-14T03:00:00Z" },
    { id: "c", projectId: "p2", title: "Fix old", status: "idle", updatedAt: "2026-10-14T01:00:00Z" },
    {
      id: "d",
      projectId: "p1",
      title: "Gone",
      status: "idle",
      updatedAt: "2026-10-14T04:00:00Z",
      deletedAt: "2026-10-14T05:00:00Z",
    },
  ],
};

describe("resolveProject", () => {
  it("matches a live project by normalised workspace root", () => {
    expect(resolveProject(shell, "/home/srvr/repos/argus/")?.id).toBe("p1");
  });

  it("ignores deleted projects", () => {
    expect(resolveProject(shell, "/home/srvr/repos/old")).toBeUndefined();
  });
});

describe("filterThreads", () => {
  it("lists live threads newest first", () => {
    expect(filterThreads(shell, {}).map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("filters by project, title and status, and caps the count", () => {
    expect(filterThreads(shell, { projectId: "p1" }).map((t) => t.id)).toEqual(["b", "a"]);
    expect(filterThreads(shell, { titleContains: "fix" }).map((t) => t.id)).toEqual(["a", "c"]);
    expect(filterThreads(shell, { statuses: ["running"] }).map((t) => t.id)).toEqual(["a"]);
    expect(filterThreads(shell, { limit: 1 }).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("summarizeProjection", () => {
  it("returns the last messages and the active run", () => {
    const projection: Projection = {
      ...runningProjection,
      messages: [
        { role: "user", text: "first", createdAt: "1" },
        { role: "assistant", text: "second", createdAt: "2" },
        { role: "user", text: "third", createdAt: "3" },
      ],
    };
    expect(summarizeProjection(projection, 2)).toEqual({
      thread: runningProjection.thread,
      activeRunId: "run-2",
      steerableRunId: "run-2",
      totalMessages: 3,
      messages: [
        { role: "assistant", text: "second", createdAt: "2" },
        { role: "user", text: "third", createdAt: "3" },
      ],
    });
  });
});
