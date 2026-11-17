import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Replay for a promotion that ran nothing (argus-config#1060, map #1048).
//
// GitHub skips every push-triggered workflow when the head commit of a push carries the
// release bot's skip-CI marker, so promoting a release commit deploys nothing. Every
// deploy-branch workflow here is path-filtered on push, so GitHub plans from the push
// diff and the skipped changes would never ship on a later promotion either. The owner's
// replay is a `workflow_dispatch` on `deploy`: it redeploys that target at the head of
// `deploy`. A dispatch can name any ref, so each deploying job must still refuse
// everything but `refs/heads/deploy`.
//
// The files are read as text, as in workflow-gates.test.ts: the repo has no YAML parser
// at the root and a new dependency is not worth a few line-shaped checks.

const workflows = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

const DEPLOY_REF = "github.ref == 'refs/heads/deploy'";

// How many workflows had a push-to-deploy trigger when this guard was written. A parse
// that finds fewer has stopped seeing them, which would pass every case below vacuously.
const KNOWN_DEPLOY_WORKFLOWS = 11;

interface Job {
  name: string;
  condition: string | undefined;
}

// The text of a top-level block (`on:`, `jobs:`) up to the next top-level key.
function topLevelBlock(source: string, key: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) break;
    body.push(line);
  }
  return body;
}

// The value of `if:` at 4 spaces, inline or a folded `>-` block, as one line.
function jobCondition(jobLines: string[]): string | undefined {
  const at = jobLines.findIndex((line) => /^ {4}if:/.test(line));
  if (at === -1) return undefined;
  const inline = jobLines[at].replace(/^ {4}if:\s*/, "").trim();
  if (inline !== ">-" && inline !== ">") return inline;
  const folded: string[] = [];
  for (const line of jobLines.slice(at + 1)) {
    if (!line.startsWith("      ")) break;
    folded.push(line.trim());
  }
  return folded.join(" ");
}

function jobsOf(source: string): Job[] {
  const jobs: Job[] = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of topLevelBlock(source, "jobs")) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.push({ name: current.name, condition: jobCondition(current.lines) });
      current = { name: header[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) jobs.push({ name: current.name, condition: jobCondition(current.lines) });
  return jobs;
}

// Whether `on.push.branches` names `deploy`.
function pushesToDeploy(source: string): boolean {
  const lines = topLevelBlock(source, "on");
  const push = lines.findIndex((line) => /^ {2}push:/.test(line));
  if (push === -1) return false;
  for (const line of lines.slice(push + 1)) {
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}branches:\s*\[[^\]]*\bdeploy\b[^\]]*\]/.test(line)) return true;
  }
  return false;
}

function hasDispatch(source: string): boolean {
  return topLevelBlock(source, "on").some((line) => /^ {2}workflow_dispatch:/.test(line));
}

// A pull_request dry run never deploys; every other job in a deploy workflow does.
function deploysProduction(job: Job): boolean {
  return job.condition !== "github.event_name == 'pull_request'";
}

function deployWorkflows(files: Record<string, string>): string[] {
  return Object.keys(files)
    .filter((file) => pushesToDeploy(files[file]))
    .sort();
}

// Every reason a workflow cannot be replayed by an owner dispatch, as readable strings.
function replayProblems(file: string, source: string): string[] {
  const problems: string[] = [];
  if (!hasDispatch(source)) problems.push(`${file}: pushes to deploy but has no workflow_dispatch`);
  for (const job of jobsOf(source).filter(deploysProduction)) {
    const where = `${file} job ${job.name}`;
    if (job.condition === undefined) {
      problems.push(`${where}: no if:, so a dispatch from any ref would deploy`);
      continue;
    }
    if (!job.condition.includes(DEPLOY_REF)) {
      problems.push(`${where}: if: does not require ${DEPLOY_REF}`);
    }
    if (job.condition.includes("github.event_name == 'push'") && !job.condition.includes("github.event_name == 'workflow_dispatch'")) {
      problems.push(`${where}: if: allows a push but not a dispatch`);
    }
  }
  if (/github\.event\.(before|after|head_commit)/.test(source)) {
    problems.push(`${file}: reads push-only event context that is empty on a dispatch`);
  }
  if (!/^# .*dispatch.*owner step/im.test(source)) {
    problems.push(`${file}: no header comment saying a dispatch is an owner step`);
  }
  return problems;
}

const files: Record<string, string> = {};
for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
  files[file] = readFileSync(join(workflows, file), "utf8");
}

describe("deploy-branch workflows can be replayed by an owner dispatch", () => {
  const targets = deployWorkflows(files);

  it("sees every workflow that pushes to deploy", () => {
    expect(targets.length).toBeGreaterThanOrEqual(KNOWN_DEPLOY_WORKFLOWS);
  });

  it.each(targets)("%s has a dispatch, refuses other refs and checks out deploy", (file) => {
    expect(replayProblems(file, files[file])).toEqual([]);
  });
});

describe("the replay check itself", () => {
  const good = [
    "name: x",
    "# A dispatch is still a deploy: an owner step, never run by an agent.",
    "on:",
    "  push:",
    "    branches: [deploy]",
    "  workflow_dispatch:",
    "jobs:",
    "  deploy:",
    "    if: github.ref == 'refs/heads/deploy'",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");

  it("passes a workflow with a dispatch and a deploy-only job", () => {
    expect(pushesToDeploy(good)).toBe(true);
    expect(replayProblems("good.yml", good)).toEqual([]);
  });

  it("fails a push-to-deploy trigger with no dispatch", () => {
    const source = good.replace("  workflow_dispatch:\n", "");
    expect(replayProblems("w.yml", source)).toContain("w.yml: pushes to deploy but has no workflow_dispatch");
  });

  it("fails a deploying job with no if:", () => {
    const source = good.replace("    if: github.ref == 'refs/heads/deploy'\n", "");
    expect(replayProblems("w.yml", source)).toContain("w.yml job deploy: no if:, so a dispatch from any ref would deploy");
  });

  it("fails a deploying job that does not pin the deploy ref", () => {
    const source = good.replace("github.ref == 'refs/heads/deploy'", "github.event_name == 'workflow_dispatch'");
    expect(replayProblems("w.yml", source).join("\n")).toContain("does not require");
  });

  it("fails a job that allows a push but not a dispatch", () => {
    const source = good.replace(
      "github.ref == 'refs/heads/deploy'",
      "github.event_name == 'push' && github.ref == 'refs/heads/deploy'",
    );
    expect(replayProblems("w.yml", source).join("\n")).toContain("allows a push but not a dispatch");
  });

  it("accepts a folded if: that allows both events on deploy", () => {
    const source = good.replace(
      "    if: github.ref == 'refs/heads/deploy'\n",
      [
        "    if: >-",
        "      (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
        "      && github.ref == 'refs/heads/deploy'",
        "",
      ].join("\n"),
    );
    expect(replayProblems("w.yml", source)).toEqual([]);
  });

  it("leaves a pull_request dry run alone", () => {
    const source = good.replace(
      "jobs:\n",
      "jobs:\n  dry-run:\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n",
    );
    expect(replayProblems("w.yml", source)).toEqual([]);
  });

  it("fails a job that reads push-only context", () => {
    const source = `${good}      - run: echo \${{ github.event.before }}\n`;
    expect(replayProblems("w.yml", source).join("\n")).toContain("push-only event context");
  });

  it("ignores a workflow that does not push to deploy", () => {
    expect(pushesToDeploy(good.replace("[deploy]", "[main]"))).toBe(false);
  });
});
