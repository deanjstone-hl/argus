import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ciScript = fileURLToPath(new URL("./ci.sh", import.meta.url));
const hookScript = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));
const heavyLockScript = fileURLToPath(new URL("./heavy-lock.sh", import.meta.url));

// Stands in for pnpm: logs each call, and answers `list` with the repo root alone,
// which ci.sh reads as "no workspace member changed".
const fakePnpm = `#!/usr/bin/env bash
echo "pnpm $*" >> "$CI_TEST_LOG"
echo "VITEST_MAX_WORKERS=\${VITEST_MAX_WORKERS:-} NODE_OPTIONS=\${NODE_OPTIONS:-}" >> "$CI_TEST_LOG.env"
if [[ " $* " == *" list "* ]]; then pwd -P; fi
`;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

interface ScratchOptions {
  // A push to main: origin/main already holds HEAD, so the merge base with origin/main is HEAD
  // itself and only CI_BASE_REF (the push's `before`) says what the push changed.
  pushed?: boolean;
  // Put a gitleaks on PATH, as the CI job does.
  gitleaks?: boolean;
}

interface Scratch {
  work: string;
  log: string;
  env: Record<string, string>;
}

// A scratch repo whose origin/main holds one commit and whose HEAD adds `changedFile`. An
// extraEnv value of `$BASE` stands for the SHA of the first commit. CI_SERIAL defaults to
// "0" so a test does not depend on how much memory the host running it has.
function scratchRepo(changedFile: string, extraEnv: Record<string, string> = {}, options: ScratchOptions = {}): Scratch {
  const root = mkdtempSync(join(tmpdir(), "ci-changed-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const bin = join(root, "bin");
  const log = join(root, "pnpm.log");
  mkdirSync(bin);
  mkdirSync(join(work, "scripts"), { recursive: true });
  for (const [name, body] of [
    ["pnpm", fakePnpm],
    ["node", 'echo "node $*" >> "$CI_TEST_LOG"\n'],
    ...(options.gitleaks ? [["gitleaks", "exit 0\n"]] : []),
  ]) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body.replace(/^#!.*\n/, "")}`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(log, "");
  writeFileSync(`${log}.env`, "");

  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.email", "ci@example.test");
  git(work, "config", "user.name", "ci");
  copyFileSync(ciScript, join(work, "scripts", "ci.sh"));
  chmodSync(join(work, "scripts", "ci.sh"), 0o755);
  // ci.sh re-runs itself under the host lock (argus-config#1506): copy the script and keep the
  // lock file local, so this test never waits on, or takes, the real host lock.
  copyFileSync(heavyLockScript, join(work, "scripts", "heavy-lock.sh"));
  writeFileSync(join(work, "README.md"), "base\n");
  writeFileSync(join(work, "scripts", "scrub-scan.sh"), 'echo "scrub-scan $*" >> "$CI_TEST_LOG"\n');
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "origin", "main");
  const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).stdout.trim();

  mkdirSync(dirname(join(work, changedFile)), { recursive: true });
  writeFileSync(join(work, changedFile), "changed\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "change");
  if (options.pushed) git(work, "push", "--quiet", "origin", "main");
  const env = Object.fromEntries(Object.entries(extraEnv).map(([key, value]) => [key, value === "$BASE" ? baseSha : value]));

  return {
    work,
    log,
    env: {
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      CI_TEST_LOG: log,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      HEAVY_LOCK_FILE: join(root, "heavy.lock"),
      HEAVY_LOCK_PSI_FILE: join(root, "no-pressure-file"),
      CI_SERIAL: "0",
      ...env,
    },
  };
}

function readLog(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

// The pnpm calls `ci.sh --changed root` makes, and the env each one saw.
function ciRun(changedFile: string, extraEnv: Record<string, string> = {}, options: ScratchOptions = {}) {
  const { work, log, env } = scratchRepo(changedFile, extraEnv, options);
  const result = spawnSync("bash", ["scripts/ci.sh", "--changed", "root"], { cwd: work, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`ci.sh exited ${result.status}: ${result.stdout}${result.stderr}`);
  return { calls: readLog(log), seen: readLog(`${log}.env`) };
}

function pnpmCalls(changedFile: string, extraEnv: Record<string, string> = {}, options: ScratchOptions = {}): string[] {
  return ciRun(changedFile, extraEnv, options).calls;
}

describe("ci.sh --changed root", () => {
  it("runs the scripts tests when only a workflow changed", () => {
    // scripts/workflow-gates.test.ts reads .github/workflows/*.yml, so a workflow
    // edit can break a scripts test.
    expect(pnpmCalls(".github/workflows/deploy.yml")).toContain("pnpm run test:scripts --maxWorkers=1");
  });

  it("bounds the scripts tests to one worker outside GitHub Actions, and only there", () => {
    // Unbounded, vitest forks one worker per core, each with the full heap cap; on the
    // 7.8 GB homelab that peak got sessions killed under memory pressure (argus#41).
    const testCalls = (calls: string[]) => calls.filter((call) => call.startsWith("pnpm run test:scripts"));
    expect(testCalls(pnpmCalls("scripts/other.test.ts"))).toEqual(["pnpm run test:scripts --maxWorkers=1"]);
    expect(testCalls(pnpmCalls("scripts/other.test.ts", { GITHUB_ACTIONS: "true" }))).toEqual(["pnpm run test:scripts"]);
  });

  it("runs the scripts tests when scripts/ changed", () => {
    expect(pnpmCalls("scripts/other.test.ts")).toContain("pnpm run test:scripts --maxWorkers=1");
  });

  it("skips the scripts tests and the root workspace for an unrelated file", () => {
    expect(pnpmCalls("README.md")).not.toContain("pnpm run test:scripts");
  });
});

// A trunk push to main is scoped to what the push changed (argus#65, argus-config#1586): CI
// gives ci.sh the push's `before` SHA as CI_BASE_REF, since origin/main already holds HEAD.
describe("ci.sh --changed on a push to main", () => {
  const scriptsTest = "pnpm run test:scripts --maxWorkers=1";

  it("diffs against CI_BASE_REF, so a push that changed scripts/ still runs the scripts tests", () => {
    const calls = pnpmCalls("scripts/other.test.ts", { CI_BASE_REF: "$BASE" }, { pushed: true });
    expect(calls).toContain(scriptsTest);
  });

  it("skips the root workspace and the scripts tests when the push changed nothing they cover", () => {
    const calls = pnpmCalls("README.md", { CI_BASE_REF: "$BASE" }, { pushed: true });
    expect(calls).not.toContain(scriptsTest);
    expect(calls.some((call) => call.startsWith("pnpm install"))).toBe(false);
    expect(calls.some((call) => call.includes("run typecheck"))).toBe(false);
  });

  it("without CI_BASE_REF a pushed HEAD diffs against itself and checks nothing (the old behaviour this replaces)", () => {
    expect(pnpmCalls("scripts/other.test.ts", {}, { pushed: true })).not.toContain(scriptsTest);
  });

  it.each([
    ["an all-zero before (a new branch)", "0000000000000000000000000000000000000000"],
    ["a before the checkout cannot find (a force-push)", "1111111111111111111111111111111111111111"],
  ])("checks the whole root workspace for %s", (_name, before) => {
    const calls = pnpmCalls("README.md", { CI_BASE_REF: before }, { pushed: true });
    expect(calls).toContain("pnpm -r --if-present run typecheck");
    expect(calls).toContain(scriptsTest);
  });
});

// Docs-only changes skip the heavy jobs (argus#65): the docs index and the scrub scan are the
// only checks a change under docs/ can break, and neither needs an install.
describe("ci.sh --changed for a docs-only change", () => {
  it("runs the docs index and the scrub scan, with no install and no scripts tests", () => {
    const calls = pnpmCalls("docs/guide.md", {}, { gitleaks: true });
    expect(calls).toContain("node scripts/docs-list.ts --check");
    expect(calls.some((call) => call.startsWith("scrub-scan"))).toBe(true);
    expect(calls.some((call) => call.startsWith("pnpm install"))).toBe(false);
    expect(calls).not.toContain("pnpm run test:scripts --maxWorkers=1");
  });

  it("still runs the docs index where gitleaks is missing (a local pre-push)", () => {
    const calls = pnpmCalls("docs/guide.md");
    expect(calls).toContain("node scripts/docs-list.ts --check");
    expect(calls.some((call) => call.startsWith("scrub-scan"))).toBe(false);
  });

  it.each([["links.json"], [".gitleaks.toml"], [".githooks/pre-push"], ["apps/agent-cli/deploy.sh"]])(
    "runs the scripts tests for %s, which a scripts test reads",
    (file) => {
      expect(pnpmCalls(file, {}, { gitleaks: true })).toContain("pnpm run test:scripts --maxWorkers=1");
    },
  );
});

// A full gate on a small host started about 20 node and vitest processes at once and drove memory
// pressure to some avg60 94 (argus#36, argus-config#1267). Serial mode runs one package at a time,
// one vitest worker each; GitHub Actions runners are dedicated, so CI keeps the parallelism.
describe("ci.sh serial mode", () => {
  // package.json is a root config file, so --changed widens to the whole root workspace.
  const smallHost = { CI_SERIAL: "", CI_SERIAL_MAX_MEM_MB: "999999999" };
  const bigHost = { CI_SERIAL: "", CI_SERIAL_MAX_MEM_MB: "1" };
  const serialCalls = (calls: string[]) => calls.filter((call) => call.includes("--workspace-concurrency=1"));

  it("CI_SERIAL=1 runs every root step one package at a time", () => {
    const { calls } = ciRun("package.json", { CI_SERIAL: "1" });
    for (const step of ["typecheck", "lint", "build"]) {
      expect(calls).toContain(`pnpm -r --workspace-concurrency=1 --if-present run ${step}`);
    }
    expect(calls).toContain("pnpm -r --if-present --workspace-concurrency=1 run test");
  });

  it("CI_SERIAL=1 gives every pnpm call one vitest worker and a heap cap", () => {
    const { seen } = ciRun("package.json", { CI_SERIAL: "1" });
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) expect(line).toBe("VITEST_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=1536");
  });

  it("CI_SERIAL=1 keeps a NODE_OPTIONS the caller already set", () => {
    const { seen } = ciRun("package.json", { CI_SERIAL: "1", NODE_OPTIONS: "--max-old-space-size=512" });
    for (const line of seen) expect(line).toContain("NODE_OPTIONS=--max-old-space-size=512");
  });

  it("CI_SERIAL=0 keeps the parallel workspace run and sets no worker cap", () => {
    const { calls, seen } = ciRun("package.json", { ...smallHost, CI_SERIAL: "0" });
    expect(calls).toContain("pnpm -r --if-present run typecheck");
    expect(calls).toContain("pnpm -r --if-present run build");
    expect(serialCalls(calls)).toEqual(["pnpm -r --if-present --workspace-concurrency=1 run test"]);
    for (const line of seen) expect(line).toBe("VITEST_MAX_WORKERS= NODE_OPTIONS=");
  });

  it("is the default on a host with little memory", () => {
    const { calls, seen } = ciRun("package.json", smallHost);
    expect(calls).toContain("pnpm -r --workspace-concurrency=1 --if-present run typecheck");
    for (const line of seen) expect(line).toContain("VITEST_MAX_WORKERS=1");
  });

  it("is not the default on a host with plenty of memory", () => {
    const { calls } = ciRun("package.json", bigHost);
    expect(calls).toContain("pnpm -r --if-present run typecheck");
  });

  it("is not the default in GitHub Actions, even on a small host", () => {
    const { calls, seen } = ciRun("package.json", { ...smallHost, GITHUB_ACTIONS: "true" });
    expect(calls).toContain("pnpm -r --if-present run typecheck");
    for (const line of seen) expect(line).toContain("VITEST_MAX_WORKERS= ");
  });

  it("CI_SERIAL=1 still serialises in GitHub Actions", () => {
    const { calls } = ciRun("package.json", { CI_SERIAL: "1", GITHUB_ACTIONS: "true" });
    expect(calls).toContain("pnpm -r --workspace-concurrency=1 --if-present run typecheck");
  });

  it("the pre-push hook runs the gate with no override, so a small host gets serial mode", () => {
    const { work, log, env } = scratchRepo("package.json", smallHost);
    mkdirSync(join(work, ".githooks"));
    copyFileSync(hookScript, join(work, ".githooks", "pre-push"));
    chmodSync(join(work, ".githooks", "pre-push"), 0o755);
    const result = spawnSync("bash", [".githooks/pre-push"], {
      cwd: work,
      encoding: "utf8",
      env,
      input: `refs/heads/main ${"a".repeat(40)} refs/heads/main ${"0".repeat(40)}\n`,
    });
    if (result.status !== 0) throw new Error(`pre-push exited ${result.status}: ${result.stdout}${result.stderr}`);
    const calls = readLog(log);
    expect(calls).toContain("pnpm -r --workspace-concurrency=1 --if-present run typecheck");
    for (const line of readLog(`${log}.env`)) expect(line).toContain("VITEST_MAX_WORKERS=1");
  });
});

describe("ci.yml checkout depth", () => {
  it("never picks 0 in the middle of an && / || expression, where it is falsy", () => {
    // `cond && 0 || 1` is 1 even when cond holds, which left the PR run shallow and
    // made `ci.sh --changed` fail to find the merge base.
    const ci = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
    expect(ci).toMatch(/fetch-depth: \$\{\{ github\.event_name != 'pull_request' && 1 \|\| 0 \}\}/);
    expect(ci).not.toMatch(/&& 0 \|\|/);
  });
});
