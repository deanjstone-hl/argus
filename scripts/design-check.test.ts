import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The design-system `design-check` registry item, pinned at v3.0.2: a non-blocking
// Impeccable detector. The item's own behaviour is tested in design-system; these
// cases pin how it is wired into this monorepo — the workflow sits at the repo root
// (a workflow under apps/ would never run) and the script skips the `aliases.ui`
// directory of every components.json here. The local edits to the item are its
// runs-on: the item's hosted default is kept as a plain `ubuntu-latest`, so the
// check runs on a GitHub-hosted runner and takes no homelab slot (homelab#368). The
// rest of this repo runs on the homelab.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "design-detect.sh");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "design-detect.yml"), "utf8");

const componentsJson = ["apps/watchtower"].map((app) =>
  join(app, "components.json"),
);

let workDir: string | undefined;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

describe("design-detect workflow", () => {
  it("runs the detector without ever blocking a merge", () => {
    expect(workflow).toMatch(/continue-on-error: true\n\s+env:\n\s+BASE_SHA:/);
    expect(workflow).toContain('run: bash scripts/design-detect.sh "$BASE_SHA"');
  });

  it("runs on a GitHub-hosted runner, so it takes no homelab slot", () => {
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).not.toContain("self-hosted");
  });

  it("needs no sparse-checkout clear, as a hosted runner starts clean", () => {
    expect(workflow).not.toContain("core.sparseCheckout");
  });

  it("runs when components.json or the detector config changes", () => {
    expect(workflow).toContain("- 'components.json'");
    expect(workflow).toContain("- '.impeccable/**'");
  });
});

describe("design-detect.sh in this monorepo", () => {
  // A scratch repo holding this repo's components.json files, so the scan target is
  // chosen by the real aliases and no network call (the detector itself) is needed.
  function scratchRepo(): string {
    workDir = mkdtempSync(join(tmpdir(), "design-check-"));
    git(workDir, "init", "-q");
    for (const file of componentsJson) {
      mkdirSync(join(workDir, dirname(file)), { recursive: true });
      cpSync(join(repoRoot, file), join(workDir, file));
    }
    git(workDir, "add", "-A");
    git(workDir, "commit", "-q", "-m", "base");
    return workDir;
  }

  it("skips the registry-owned ui directory of every app", () => {
    const repo = scratchRepo();
    const base = git(repo, "rev-parse", "HEAD");
    for (const app of ["apps/watchtower"]) {
      const ui = join(repo, app, "src", "components", "ui");
      mkdirSync(ui, { recursive: true });
      writeFileSync(join(ui, "button.tsx"), "export const Button = () => null;\n");
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "registry files");

    const result = spawnSync("bash", [script, base], { cwd: repo, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No UI files changed.");
    expect(result.stdout).not.toContain("Not skipped");
  });
});
