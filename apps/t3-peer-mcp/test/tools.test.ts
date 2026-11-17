import { describe, expect, it } from "vitest";
import type { ShellSnapshot } from "../src/commands.js";
import { pickModel, resolvePeer, stampMessage, type PeerRegistry } from "../src/tools.js";

const handle = (name: string) => ({ name, client: () => Promise.reject(new Error("unused")) });

describe("resolvePeer", () => {
  it("defaults to the only configured peer", () => {
    expect(resolvePeer({ self: "wsl", peers: [handle("homelab")] }, undefined).name).toBe("homelab");
  });

  it("requires a name when several peers are configured", () => {
    const registry: PeerRegistry = { self: "wsl", peers: [handle("homelab"), handle("mini")] };
    expect(() => resolvePeer(registry, undefined)).toThrow("homelab, mini");
    expect(resolvePeer(registry, "mini").name).toBe("mini");
    expect(() => resolvePeer(registry, "nope")).toThrow('Unknown peer "nope"');
  });
});

describe("stampMessage", () => {
  it("names the sending environment on a trailing line", () => {
    expect(stampMessage("wsl", "hi")).toBe("hi\n\n[Sent via t3-peer from the wsl T3 environment]");
  });
});

describe("pickModel", () => {
  const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const sonnet = { instanceId: "claudeAgent", model: "claude-sonnet-5-5" };
  const base: ShellSnapshot = {
    projects: [{ id: "p1", title: "argus", workspaceRoot: "/r" }],
    threads: [
      { id: "a", projectId: "p1", title: "old", status: "idle", updatedAt: "1", modelSelection: opus },
      { id: "b", projectId: "p1", title: "new", status: "idle", updatedAt: "2", modelSelection: sonnet },
    ],
  };

  it("prefers the project's default model", () => {
    const shell: ShellSnapshot = { ...base, projects: [{ ...base.projects[0]!, defaultModelSelection: opus }] };
    expect(pickModel(shell, "p1")).toEqual(opus);
  });

  it("falls back to the most recently updated thread's model", () => {
    expect(pickModel(base, "p1")).toEqual(sonnet);
  });

  it("falls back to Opus when nothing else is known", () => {
    expect(pickModel({ ...base, threads: [] }, "p1")).toEqual(opus);
  });
});
