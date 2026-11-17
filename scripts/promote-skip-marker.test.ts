import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/promote.sh refuses a target whose commit message carries the skip-CI marker
// (argus-config#1060). GitHub runs no push-triggered workflow when the head commit of a
// push carries one, so promoting the release bot's commit deploys nothing. The refusal
// names the nearest first-parent ancestor without a marker; it never ships that SHA
// itself, because the deploy gate approves the literal command it was shown.
//
// The marker is built from parts: a test file that spells it whole is harmless, but a
// commit message that did would skip its own CI.

const root = fileURLToPath(new URL("..", import.meta.url));
const promote = join(root, "scripts/promote.sh");

const marker = (word: string) => `[${word}]`;
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...identity } }).trim();
}

function run(args: string[], cwd: string) {
  const { GITHUB_ACTIONS: _ignored, ...inherited } = process.env;
  const result = spawnSync("bash", [promote, ...args], { cwd, encoding: "utf8", env: { ...inherited, ...identity } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("scripts/promote.sh and the skip-CI marker", () => {
  let work: string;
  let repo: string;
  const originGit = () => join(work, "origin.git");
  const remoteDeploy = () => spawnSync("git", ["-C", originGit(), "rev-parse", "--verify", "--quiet", "refs/heads/deploy"], { encoding: "utf8" }).stdout.trim();
  const commit = (message: string) => {
    git(repo, "commit", "-q", "--allow-empty", "-m", message);
    git(repo, "push", "-q", "origin", "HEAD:main");
    return git(repo, "rev-parse", "HEAD");
  };

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "promote-skip-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", originGit()]);
    execFileSync("git", ["clone", "-q", originGit(), join(work, "repo")], { stdio: "ignore" });
    repo = join(work, "repo");
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  describe.each([
    ["skip ci", `chore(release): 1.0.0 ${marker("skip ci")}`],
    ["ci skip", `chore(release): 1.0.0 ${marker("ci skip")}`],
    ["no ci", `chore(release): 1.0.0 ${marker("no ci")}`],
    ["skip actions", `chore(release): 1.0.0 ${marker("skip actions")}`],
    ["actions skip", `chore(release): 1.0.0 ${marker("actions skip")}`],
    ["upper case", `chore(release): 1.0.0 ${marker("SKIP CI")}`],
    ["body, not subject", `chore(release): 1.0.0\n\nnotes ${marker("skip ci")}`],
    ["skip-checks trailer", "chore(release): 1.0.0\n\nskip-checks: true"],
    ["skip-checks trailer, no space", "chore(release): 1.0.0\n\nSkip-Checks:true"],
  ])("a target carrying %s", (_name, message) => {
    let safe: string;
    let marked: string;
    beforeEach(() => {
      commit("base");
      safe = commit("a feature (#1)");
      marked = commit(message);
    });

    it("is refused, names the parent to promote, and pushes nothing", () => {
      const result = run([marked], repo);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain("skip-CI marker");
      expect(result.output).toContain("no workflow");
      expect(result.output).toContain(`scripts/promote.sh ${safe}`);
      expect(remoteDeploy()).toBe("");
    });

    it("is refused on a dry run too", () => {
      const result = run(["--dry-run", "main"], repo);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`scripts/promote.sh ${safe}`);
      expect(result.output).not.toContain("dry run, would run");
    });
  });

  it("walks past stacked marker commits to the first commit without one", () => {
    commit("base");
    const safe = commit("a feature (#1)");
    commit(`chore(release): 1.0.0 ${marker("skip ci")}`);
    const top = commit(`chore(release): 1.0.1 ${marker("ci skip")}`);
    const result = run([top], repo);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`scripts/promote.sh ${safe}`);
    expect(remoteDeploy()).toBe("");
  });

  it("walks the first-parent chain, not a merged-in side branch", () => {
    commit("base");
    const trunk = commit("trunk (#1)");
    git(repo, "checkout", "-q", "-b", "side");
    git(repo, "commit", "-q", "--allow-empty", "-m", "side work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #2 from side", "side");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const merge = git(repo, "rev-parse", "HEAD");
    const top = commit(`chore(release): 1.0.0 ${marker("skip ci")}`);
    const result = run([top], repo);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`scripts/promote.sh ${merge}`);
    expect(result.output).not.toContain(trunk.slice(0, 7) + " ");
  });

  it("says nothing is deployable, and suggests nothing, when the marker commit sits directly above deploy", () => {
    commit("base");
    const deployed = commit("a feature (#1)");
    expect(run([deployed], repo).status).toBe(0);
    const marked = commit(`chore(release): 1.0.0 ${marker("skip ci")}`);
    const result = run([marked], repo);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no deployable commit ahead of deploy");
    expect(result.output).not.toContain("scripts/promote.sh ");
    expect(remoteDeploy()).toBe(deployed);
  });

  it("says nothing is deployable when every commit down to deploy carries a marker", () => {
    commit("base");
    const deployed = commit("a feature (#1)");
    run([deployed], repo);
    commit(`chore(release): 1.0.0 ${marker("skip ci")}`);
    const top = commit(`chore(release): 1.0.1 ${marker("skip ci")}`);
    const result = run([top], repo);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no deployable commit ahead of deploy");
    expect(remoteDeploy()).toBe(deployed);
  });

  it("says nothing is deployable when the first promotion has only marker commits to offer", () => {
    const only = commit(`chore: seed ${marker("skip ci")}`);
    const result = run([only], repo);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no deployable commit ahead of deploy");
    expect(remoteDeploy()).toBe("");
  });

  it("still promotes an ordinary commit", () => {
    commit("base");
    const ordinary = commit("a feature (#1)");
    const result = run([ordinary], repo);
    expect(result.status, result.output).toBe(0);
    expect(remoteDeploy()).toBe(ordinary);
  });

  it("promotes a safe commit named explicitly below a marker commit", () => {
    commit("base");
    const safe = commit("a feature (#1)");
    commit(`chore(release): 1.0.0 ${marker("skip ci")}`);
    const result = run([safe], repo);
    expect(result.status, result.output).toBe(0);
    expect(remoteDeploy()).toBe(safe);
  });

  it("ignores a marker on a commit that is in the range but is not the head", () => {
    commit("base");
    commit(`chore(release): 1.0.0 ${marker("skip ci")}`);
    const head = commit("a feature (#2)");
    const result = run([head], repo);
    expect(result.status, result.output).toBe(0);
    expect(remoteDeploy()).toBe(head);
  });

  it("does not mistake a similar word for the marker", () => {
    commit("base");
    const head = commit("docs: explain why we never write skip ci or [skip] in subjects");
    const result = run([head], repo);
    expect(result.status, result.output).toBe(0);
    expect(remoteDeploy()).toBe(head);
  });
});
