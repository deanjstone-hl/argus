import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Trunk-based development (argus-config#1176, #1183): agents push straight to main, so
// every push to main must run CI. CI used to skip the push a PR squash-merge made (a Guard
// job compared the merge tree with the tested PR head, argus-config#1173); that skip is gone,
// and these tests pin that nothing in ci.yml reads the commit message, committer or PR to
// decide whether a main push is checked. Release has no such gate either: it runs on the
// `deploy` push, once per promotion (argus#1066), and scripts/deploy-branch.test.ts pins its
// wiring.

const root = fileURLToPath(new URL("../", import.meta.url));
const workflows = join(root, ".github", "workflows");
const ci = readFileSync(join(workflows, "ci.yml"), "utf8");
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const changesJob = ci.slice(ci.indexOf("\n  changes:\n"), ci.indexOf("\n  build:\n"));
const changesIf = changesJob.match(/\n    if: (.+)\n/)?.[1] ?? "";

describe("trunk: every push to main is checked", () => {
  it("triggers CI on a push to main", () => {
    expect(ci).toMatch(/\n  push:\n    branches: \[main\]\n/);
  });

  it("has no job that can skip a main push by who made it or what its subject says", () => {
    expect(ci).not.toMatch(/\n  guard:\n/);
    expect(ci).not.toContain("head_commit");
    expect(ci).not.toContain("web-flow");
    expect(ci).not.toContain("pr-merge-push");
    expect(ci).not.toContain("needs.guard");
    expect(existsSync(join(root, "scripts", "ci", "pr-merge-push.sh"))).toBe(false);
  });

  it("starts Changes straight from the event, with no condition and no need", () => {
    expect(changesJob).not.toMatch(/\n    needs:/);
    expect(changesIf).toBe("");
  });

  it.each([["build"], ["nested"]])("%s runs only when Changes succeeded", (job) => {
    const start = ci.indexOf(`\n  ${job}:\n`);
    const block = ci.slice(start, ci.indexOf("\n    runs-on:", start));
    expect(block).toContain("!cancelled()");
    expect(block).toContain("needs.changes.result == 'success'");
  });
});

describe("trunk: the local check", () => {
  it("is `pnpm check`, which runs scripts/ci.sh over what differs from origin/main", () => {
    expect(rootPackage.scripts.check).toBe("bash scripts/ci.sh --changed");
  });

  it("is named in README.md and AGENTS.md", () => {
    for (const doc of ["README.md", "AGENTS.md"]) {
      expect(readFileSync(join(root, doc), "utf8"), doc).toContain("pnpm check");
    }
  });

  it("is the pre-push gate too, so the hook and the check cannot drift", () => {
    expect(readFileSync(join(root, ".githooks", "pre-push"), "utf8")).toContain("scripts/ci.sh\" --changed");
  });
});

// argus#928: the ecosystem skills job reads two private repos with SKILLS_READ_TOKEN. With
// the secret empty (not set, or a run without it) it must pass by skipping, so every step
// after the token probe has to be gated on what the probe found. It is its own workflow,
// with no pull_request trigger, because a workflow a pull request starts reads no secret
// (argus#1207, scripts/public-safe.test.ts).
describe("ecosystem skills workflow", () => {
  const workflow = readFileSync(join(workflows, "ecosystem-skills.yml"), "utf8");
  const jobStart = workflow.indexOf("\n  ecosystem-skills:\n");
  const job = workflow.slice(jobStart);
  const steps = job.split("\n      - ").slice(1);
  const probe = steps.findIndex((step) => step.includes("id: token"));

  it("runs on a push to main that touches the manifest, weekly, and on dispatch, never on a pull request", () => {
    const events = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(events).toContain("push:");
    expect(events).toContain("schedule:");
    expect(events).toContain("workflow_dispatch:");
    expect(events).not.toContain("pull_request");
    expect(events).toContain('"ecosystem/**"');
    expect(events).toContain('"scripts/ecosystem/**"');
  });

  it("probes the secret first and only posts a notice when it is empty", () => {
    expect(jobStart).toBeGreaterThan(-1);
    expect(probe).toBe(0);
    expect(steps[probe]).toContain("::notice");
    expect(steps[probe]).not.toContain("exit 1");
  });

  it("gates every later step on the probe, so an empty secret skips them all", () => {
    expect(steps.length).toBeGreaterThan(5);
    for (const step of steps.slice(probe + 1)) {
      expect(step, step).toMatch(/if: .*steps\.token\.outputs\.present == 'true'/);
    }
  });

  it("hands the token only to the two checkouts and the probe", () => {
    const uses = job.match(/secrets\.SKILLS_READ_TOKEN/g) ?? [];
    expect(uses).toHaveLength(3);
  });

  it("is not part of ci.yml", () => {
    expect(ci).not.toContain("SKILLS_READ_TOKEN");
    expect(ci).not.toContain("ecosystem-skills");
  });
});

describe("vendored release scripts (argus#1190)", () => {
  it("fails on a hand-edited copy, on every push and pull request", () => {
    expect(ci).toMatch(/\n  pull_request:\n    branches: \[main\]\n/);
    const start = ci.indexOf("\n  release-scripts:\n");
    expect(start).toBeGreaterThan(-1);
    const block = ci.slice(start, ci.indexOf("\n  # ", start + 1));
    expect(block).not.toMatch(/\n    if:/);
    expect(block).not.toMatch(/\n    needs:/);
    expect(block).toContain("run: bash scripts/ci/release-scripts-check.sh");
  });
});

// argus#65 (argus-config#1586, map #1591): a push to main runs the tests its change touches, the
// whole suite runs once a day, and the deploy push runs no suite at all.
describe("CI cost: scoped pushes and one daily full run", () => {
  // Comments explain the wiring and name the things it avoids; the checks read YAML only.
  const uncommented = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
  const buildJob = ci.slice(ci.indexOf("\n  build:\n"), ci.indexOf("\n  nested:\n"));
  const daily = uncommented(readFileSync(join(workflows, "daily-full.yml"), "utf8"));

  it("scopes a push to main as well as a pull request, and keeps the whole run for schedule and dispatch", () => {
    expect(buildJob).toContain(
      "scripts/ci.sh ${{ (github.event_name == 'pull_request' || github.event_name == 'push') && '--changed' || '' }} root",
    );
  });

  it("hands ci.sh the push's before SHA as the diff base, on a push only", () => {
    expect(buildJob).toContain("CI_BASE_REF: ${{ github.event_name == 'push' && github.event.before || '' }}");
  });

  it("stays shallow on a push: ci.sh fetches the one commit it diffs against", () => {
    expect(buildJob).toContain("fetch-depth: ${{ github.event_name != 'pull_request' && 1 || 0 }}");
  });

  it("caches the pnpm store, keyed on the lockfile, without setup-node's cache: pnpm", () => {
    const yaml = uncommented(buildJob);
    expect(yaml).toContain("actions/cache@v4");
    expect(yaml).toContain("hashFiles('pnpm-lock.yaml')");
    expect(yaml).not.toMatch(/cache: pnpm/);
  });

  it("can be called by the daily full run", () => {
    const events = ci.slice(ci.indexOf("\non:"), ci.indexOf("\npermissions:"));
    expect(events).toContain("workflow_call:");
  });

  it("runs the whole suite daily and on dispatch, by calling ci.yml with no --changed", () => {
    const events = daily.slice(daily.indexOf("\non:"), daily.indexOf("\npermissions:"));
    expect(events).toMatch(/schedule:\n {4}- cron: "[^"]+"/);
    expect(events).toContain("workflow_dispatch:");
    expect(events).not.toContain("push:");
    expect(events).not.toContain("pull_request");
    expect(daily).toContain("uses: ./.github/workflows/ci.yml");
    expect(daily).toMatch(/\n {2}passed:\n {4}name: Daily full suite passed\n {4}needs: full\n {4}if: always\(\)\n/);
  });

  it("queues the daily run in its own group and never cancels one", () => {
    expect(daily).toMatch(/concurrency:\n {2}group: daily-full\n {2}cancel-in-progress: false/);
  });

  it("keeps the superseded-run cancel to pull requests: every main commit needs its own CI", () => {
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("is public-safe: the daily run grants its caller nothing a fork could use", () => {
    expect(daily).not.toMatch(/secrets\./);
    expect(daily).not.toContain("self-hosted");
    expect(daily).not.toContain("CI_RUNS_ON");
  });
});
