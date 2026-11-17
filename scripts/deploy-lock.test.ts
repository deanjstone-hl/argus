import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The per-host deploy lock in scripts/require-deploy-checkout.sh (argus-config#1156, map
// #1048). Every repo's copy of the guard takes one lock file per host before its checks, so
// two deploys on a host never run together: the homelab runner takes two jobs at once, each
// deploy-push workflow has its own concurrency group, and a break-glass deploy.sh is in no
// group. The guard is a child process, so a small holder keeps the lock until the guard's
// parent exits. Cases build a throwaway checkout with a local bare origin; the lock file
// lives in the scratch directory, never in the real ~/.cache.

const root = fileURLToPath(new URL("..", import.meta.url));
const makeCheckout = join(root, "scripts/test-support/make-deploy-checkout.sh");
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let work: string;
let repo: string;
let guard: string;
let lockFile: string;
const owners: ChildProcess[] = [];

const guardEnv = (extra: Record<string, string> = {}) => {
  const { GITHUB_ACTIONS: _ignored, ...inherited } = process.env;
  return { ...inherited, ...identity, ARGUS_DEPLOY_LOCK_FILE: lockFile, ...extra };
};

// `; exit $?` keeps the shell from exec-ing the guard, which would make the test runner its parent.
function runGuard(extra: Record<string, string> = {}, command = 'bash "$1"; exit $?') {
  const result = spawnSync("bash", ["-c", command, "_", guard], {
    cwd: repo,
    encoding: "utf8",
    env: guardEnv(extra),
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// A deploy that passes the guard, then keeps running; resolves once the lock is held.
async function startOwner(seconds: number): Promise<number> {
  const passed = join(work, "owner-passed");
  const child = spawn("bash", ["-c", 'bash "$1" && touch "$2" && sleep "$3"', "_", guard, passed, String(seconds)], {
    cwd: repo,
    env: guardEnv(),
    stdio: "ignore",
  });
  owners.push(child);
  const deadline = Date.now() + 15_000;
  while (!existsSync(passed)) {
    if (Date.now() > deadline) throw new Error("owner never passed the guard");
    await sleep(50);
  }
  return child.pid as number;
}

async function lockIsFree(): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnSync("flock", ["-n", lockFile, "true"]).status === 0) return true;
    await sleep(100);
  }
  return false;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "deploy-lock-"));
  repo = join(work, "repo");
  lockFile = join(work, "argus-deploy.lock");
  execFileSync("bash", [makeCheckout, repo], { env: { ...process.env, ...identity } });
  guard = join(repo, "scripts/require-deploy-checkout.sh");
});

afterEach(() => {
  for (const child of owners.splice(0)) child.kill();
  rmSync(work, { recursive: true, force: true });
});

describe("the per-host deploy lock in scripts/require-deploy-checkout.sh", () => {
  it("passes a lone guard and frees the lock once its parent exits", async () => {
    expect(runGuard().status).toBe(0);
    expect(await lockIsFree()).toBe(true);
  });

  it("refuses a second deploy with a clear error when the lock is held past the wait", async () => {
    const ownerPid = await startOwner(30);
    const result = runGuard({ ARGUS_DEPLOY_LOCK_WAIT: "1" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("another deploy holds");
    expect(result.output).toContain(`pid ${ownerPid}`);
    expect(result.output).toContain("1s");
  });

  it("waits for the holder, then goes through", async () => {
    await startOwner(2);
    const started = Date.now();
    const result = runGuard({ ARGUS_DEPLOY_LOCK_WAIT: "20" });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(result.output).toContain("waiting for the deploy lock");
  });

  it("releases the lock when the holder's parent is killed", async () => {
    await startOwner(60);
    owners[0]?.kill();
    const result = runGuard({ ARGUS_DEPLOY_LOCK_WAIT: "10" });
    expect(result.status).toBe(0);
  });

  it("does not wait on itself when one parent calls the guard twice", () => {
    expect(runGuard({}, 'bash "$1" && bash "$1"').status).toBe(0);
  });

  it("lets a child of the holder's parent straight through", () => {
    const child = join(work, "child.sh");
    writeFileSync(child, '#!/usr/bin/env bash\nbash "$1"\n');
    const result = runGuard({ ARGUS_DEPLOY_LOCK_WAIT: "2" }, `bash "$1" && bash ${child} "$1"`);
    expect(result.status).toBe(0);
  });

  it("frees the lock at once when the checks refuse", async () => {
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-q", "-m", "unpromoted"], {
      env: { ...process.env, ...identity },
    });
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.output).toContain("Refusing");
    expect(await lockIsFree()).toBe(true);
  });

  it("takes the lock before the checks, so a stale HEAD waits instead of racing a deploy", async () => {
    await startOwner(30);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-q", "-m", "unpromoted"], {
      env: { ...process.env, ...identity },
    });
    const result = runGuard({ ARGUS_DEPLOY_LOCK_WAIT: "1" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("another deploy holds");
  });

  it("skips the lock and says so when ARGUS_DEPLOY_LOCK=off", async () => {
    await startOwner(30);
    const result = runGuard({ ARGUS_DEPLOY_LOCK: "off" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("ARGUS_DEPLOY_LOCK=off");
  });

  it("refuses a non-numeric wait", () => {
    const result = runGuard({ ARGUS_DEPLOY_LOCK_WAIT: "soon" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("ARGUS_DEPLOY_LOCK_WAIT");
  });

  it("does not keep the caller's pipe open", () => {
    expect(runGuard({}, 'bash "$1" 2>&1 | cat').status).toBe(0);
  });

  it("refuses with a clear error, not a false wait, when the host lacks flock", () => {
    const lean = join(work, "lean");
    mkdirSync(lean);
    for (const tool of ["bash", "env", "dirname", "mkdir", "git", "id", "ps", "tr", "sed", "date", "mktemp", "mv", "rm", "sleep", "cat", "head"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      symlinkSync(found, join(lean, tool));
    }
    const result = runGuard({ PATH: lean });
    expect(result.status).toBe(1);
    expect(result.output).toContain("needs flock");
  });
});
