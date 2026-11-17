import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Every workflow a `deploy` push triggers carries a workflow-level concurrency block, so a
// newer promotion replaces a pending older one and never interrupts a deploy in progress
// (argus-config#1293, argus#1176). scripts/check-deploy-concurrency.py is argus-config's lint,
// copied here; the per-workflow cases pin the wiring of each workflow this issue changed.

const root = fileURLToPath(new URL("..", import.meta.url));
const lint = join(root, "scripts/check-deploy-concurrency.py");
const workflows = join(root, ".github/workflows");

function runLint(directory: string) {
  const result = spawnSync("python3", [lint, directory], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const fixed = [
  "agent-cli-deploy.yml",
  "agent-engine-deploy.yml",
  "t3-peer-mcp-wsl2-deploy.yml",
  "watchtower-deploy.yml",
  "watchtower-usage-shim-deploy.yml",
];

describe("deploy-push workflows have a workflow-level concurrency group", () => {
  it.each(fixed)("%s: top-level group is the workflow name, no cancel, no job-level block", (file) => {
    const source = readFileSync(join(workflows, file), "utf8");
    expect(source).toMatch(/^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}\n {2}cancel-in-progress: false\n/m);
    const jobs = source.slice(source.indexOf("\njobs:"));
    expect(jobs).not.toMatch(/^ {4}concurrency:/m);
  });

  it("the lint passes on the real workflows", () => {
    const { status, output } = runLint(workflows);
    expect(output).toMatch(/^OK: /);
    expect(status).toBe(0);
  });
});

describe("scripts/check-deploy-concurrency.py", () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails a deploy-push workflow with no concurrency block", () => {
    dir = mkdtempSync(join(tmpdir(), "deploy-concurrency-"));
    writeFileSync(
      join(dir, "x.yml"),
      "name: x\non:\n  push:\n    branches: [deploy]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
    );
    const { status, output } = runLint(dir);
    expect(status).toBe(1);
    expect(output).toContain("no workflow-level concurrency block");
  });

  it("does not count a job-level block", () => {
    dir = mkdtempSync(join(tmpdir(), "deploy-concurrency-"));
    writeFileSync(
      join(dir, "x.yml"),
      "name: x\non:\n  push:\n    branches: [deploy]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    concurrency:\n      group: g\n      cancel-in-progress: false\n    steps:\n      - run: true\n",
    );
    expect(runLint(dir).status).toBe(1);
  });
});
