import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The deploy-branch model for argus (argus-config#504, #600): production deploys only
// from the `deploy` branch, which scripts/promote.sh fast-forwards, and every manual
// path refuses to run unless its checkout is what `deploy` holds (scripts/
// require-deploy-checkout.sh). The behavioural cases build throwaway repos with a local
// bare origin; nothing touches the real remote. The static cases pin the wiring that
// would otherwise fail silently: a deploy.sh or wrangler script without the guard, or a
// workflow back on `main`.

const root = fileURLToPath(new URL("..", import.meta.url));
const promote = join(root, "scripts/promote.sh");
const makeCheckout = join(root, "scripts/test-support/make-deploy-checkout.sh");

const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...identity } }).trim();
}

function run(script: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const { GITHUB_ACTIONS: _ignored, ...inherited } = process.env;
  const result = spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...inherited, ...identity, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "deploy-branch-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("scripts/require-deploy-checkout.sh", () => {
  let repo: string;
  let guard: string;
  beforeEach(() => {
    repo = join(work, "repo");
    execFileSync("bash", [makeCheckout, repo]);
    guard = join(repo, "scripts/require-deploy-checkout.sh");
  });

  it("lets a clean checkout at origin/deploy through", () => {
    const result = run(guard, [], repo);
    expect(result.status, result.output).toBe(0);
  });

  it("ignores untracked files such as a .env or a build output", () => {
    writeFileSync(join(repo, ".env"), "X=1\n");
    expect(run(guard, [], repo).status).toBe(0);
  });

  it("refuses when origin has no deploy branch", () => {
    git(repo, "push", "-q", "origin", "--delete", "deploy");
    const result = run(guard, [], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("origin/deploy does not exist");
    expect(result.output).toContain("scripts/promote.sh");
  });

  it("refuses a checkout ahead of deploy", () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "unpromoted");
    const result = run(guard, [], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("scripts/promote.sh");
  });

  it("refuses a checkout behind deploy: it asks origin, not a stale local ref", () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "promoted");
    git(repo, "push", "-q", "origin", "HEAD:deploy");
    git(repo, "checkout", "-q", "--detach", "HEAD~1");
    expect(run(guard, [], repo).status).toBe(1);
  });

  it("refuses uncommitted changes to a tracked file", () => {
    writeFileSync(guard, `${readFileSync(guard, "utf8")}# local edit\n`);
    const result = run(guard, [], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("uncommitted");
  });

  it("refuses when origin is unreachable", () => {
    git(repo, "remote", "set-url", "origin", join(work, "gone.git"));
    const result = run(guard, [], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("unreachable");
  });
});

describe("scripts/promote.sh", () => {
  let repo: string;
  let one: string;
  let two: string;
  const remoteDeploy = () => git(join(work, "origin.git"), "rev-parse", "--quiet", "--verify", "refs/heads/deploy");

  beforeEach(() => {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(work, "origin.git")]);
    execFileSync("git", ["clone", "-q", join(work, "origin.git"), join(work, "repo")], { stdio: "ignore" });
    repo = join(work, "repo");
    git(repo, "commit", "-q", "--allow-empty", "-m", "one");
    git(repo, "commit", "-q", "--allow-empty", "-m", "two");
    git(repo, "push", "-q", "origin", "HEAD:main");
    one = git(repo, "rev-parse", "HEAD~1");
    two = git(repo, "rev-parse", "HEAD");
  });

  it("creates deploy at a main SHA on the first promotion", () => {
    const result = run(promote, [one], repo);
    expect(result.status, result.output).toBe(0);
    expect(remoteDeploy()).toBe(one);
    expect(result.output).toContain("creating deploy");
  });

  it("fast-forwards deploy and lists what ships", () => {
    run(promote, [one], repo);
    const result = run(promote, ["main"], repo);
    expect(result.status, result.output).toBe(0);
    expect(remoteDeploy()).toBe(two);
    expect(result.output).toContain("two");
  });

  it("changes nothing on a dry run", () => {
    const result = run(promote, ["--dry-run", one], repo);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`git push origin ${one}:refs/heads/deploy`);
    expect(spawnSync("git", ["-C", join(work, "origin.git"), "rev-parse", "--verify", "refs/heads/deploy"]).status).not.toBe(0);
  });

  it("is a no-op when deploy is already there", () => {
    run(promote, [two], repo);
    const result = run(promote, [two], repo);
    expect(result.status).toBe(0);
    expect(result.output).toContain("Nothing to do");
  });

  it("refuses a SHA that is not on main", () => {
    git(repo, "checkout", "-q", "-b", "side");
    git(repo, "commit", "-q", "--allow-empty", "-m", "side");
    git(repo, "push", "-q", "origin", "side");
    const result = run(promote, [git(repo, "rev-parse", "HEAD")], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("not on origin/main");
    expect(spawnSync("git", ["-C", join(work, "origin.git"), "rev-parse", "--verify", "refs/heads/deploy"]).status).not.toBe(0);
  });

  it("refuses to move deploy backwards: a rollback is a revert on main", () => {
    run(promote, [two], repo);
    const result = run(promote, [one], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("not a fast-forward");
    expect(result.output).toContain("git revert");
    expect(remoteDeploy()).toBe(two);
  });

  it("refuses an unknown ref", () => {
    const result = run(promote, ["no-such-ref"], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain("unknown commit");
  });

  // git only starts a pager when stdout is a terminal, so this runs the script under a
  // pty (util-linux `script`) with a pager that records that it was started (#921).
  it("never starts a pager while listing what ships", () => {
    run(promote, [one], repo);
    const marker = join(work, "pager-started");
    const pager = join(work, "pager.sh");
    writeFileSync(pager, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    const result = spawnSync("script", ["-qec", `bash ${promote} --dry-run main`, "/dev/null"], {
      cwd: repo,
      encoding: "utf8",
      input: "",
      env: { ...process.env, ...identity, GIT_PAGER: pager, GITHUB_ACTIONS: "" },
    });
    expect(result.stdout).toContain("two");
    expect(existsSync(marker), "promote.sh started the git pager").toBe(false);
  });

  it("refuses to run in GitHub Actions, where a GITHUB_TOKEN push deploys nothing", () => {
    const result = run(promote, [one], repo, { GITHUB_ACTIONS: "true" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("refusing to run in GitHub Actions");
  });
});

describe("the wiring", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const guardCall = "require-deploy-checkout.sh";

  const apps = readdirSync(join(root, "apps"), { withFileTypes: true }).filter((entry) => entry.isDirectory());

  it("calls the checkout guard from every deploy.sh", () => {
    const unguarded: string[] = [];
    for (const app of apps) {
      let script: string;
      try {
        script = read(`apps/${app.name}/deploy.sh`);
      } catch {
        continue;
      }
      if (!script.includes(guardCall)) unguarded.push(app.name);
    }
    expect(unguarded).toEqual([]);
  });

  it("starts every wrangler deploy or remote migration script with the guard", () => {
    const risky = /wrangler (deploy|pages deploy)|d1 migrations apply[^"]*--remote|scripts\/deploy\.mjs/;
    const unguarded: string[] = [];
    let checked = 0;
    for (const app of apps) {
      let pkg: { scripts?: Record<string, string> };
      try {
        pkg = JSON.parse(read(`apps/${app.name}/package.json`));
      } catch {
        continue;
      }
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (!risky.test(command)) continue;
        checked += 1;
        if (!command.startsWith(`bash ../../scripts/${guardCall} && `)) unguarded.push(`${app.name}:${name}`);
      }
    }
    // Reads the scripts it should guard: a rename that hid them would otherwise pass.
    expect(checked).toBeGreaterThanOrEqual(1);
    expect(unguarded).toEqual([]);
  });

  it("runs the deploy workflows on the deploy branch only", () => {
    for (const file of [
      "watchtower-deploy.yml",
      "watchtower-deploy-worker.yml",
    ]) {
      const trigger = read(`.github/workflows/${file}`).split("\njobs:")[0];
      expect(trigger, file).toContain("branches: [deploy]");
      expect(trigger, file).not.toContain("branches: [main]");
    }
  });

  describe("watchtower deploy workflow", () => {
    const workflow = () => read(".github/workflows/watchtower-deploy-worker.yml");

    it("can be dispatched, but only from the deploy branch", () => {
      expect(workflow().split("\njobs:")[0]).toContain("workflow_dispatch:");
      expect(workflow()).toContain("if: github.ref == 'refs/heads/deploy'");
    });

    it("runs on a change to the app, the bundled contract or the workflow itself", () => {
      const trigger = workflow().split("\njobs:")[0];
      expect(trigger).toContain('"apps/watchtower/**"');
      expect(trigger).toContain('"packages/watchtower-contract/**"');
      expect(trigger).toContain('"packages/bearer-auth/**"');
      expect(trigger).toContain('".github/workflows/watchtower-deploy-worker.yml"');
    });

    it("calls wrangler directly, not the guarded package script", () => {
      expect(workflow()).not.toContain("run: pnpm run worker:deploy");
      expect(workflow()).toContain("run: bash scripts/with-d1-id.sh pnpm exec wrangler deploy\n");
    });

    it("dry-runs, then migrates, then deploys, so a failed migration stops the job before the Worker changes", () => {
      const text = workflow();
      const dryRun = text.indexOf("wrangler deploy --dry-run");
      const migrate = text.indexOf("wrangler d1 migrations apply DB --remote");
      const deploy = text.indexOf("run: bash scripts/with-d1-id.sh pnpm exec wrangler deploy\n");
      expect(dryRun).toBeGreaterThan(-1);
      expect(migrate).toBeGreaterThan(dryRun);
      expect(deploy).toBeGreaterThan(migrate);
    });

    it("keeps the schema token apart from the deploy token", () => {
      const text = workflow();
      const migrateStep = text.slice(text.indexOf("name: Apply D1 migrations"), text.indexOf("name: Deploy to Cloudflare Workers"));
      expect(migrateStep).toContain("CLOUDFLARE_API_TOKEN: ${{ env.CLOUDFLARE_D1_TOKEN }}");
      const deployStep = text.slice(text.indexOf("name: Deploy to Cloudflare Workers"));
      // The deploy step sets no token of its own: wrangler reads the job's CLOUDFLARE_API_TOKEN, the
      // key sm-action read from Secrets Manager, never the D1 token (argus#59).
      expect(deployStep).not.toContain("CLOUDFLARE_API_TOKEN");
      expect(deployStep).not.toContain("CLOUDFLARE_D1_TOKEN");
    });

    it("leaves the Pages workflow deploying the dashboard only", () => {
      const pages = read(".github/workflows/watchtower-deploy.yml");
      expect(pages).toContain("pages deploy");
      expect(pages).not.toMatch(/wrangler deploy|migrations apply/);
    });
  });

  // A homelab unit that runs from the deploy copy (`WorkingDirectory=%h/repos/argus/...`)
  // is only redeployed when the workflow builds that copy. Built in the job's own checkout,
  // deploy.sh succeeds and restarts the unit onto the old `dist/` (argus#1051, argus#1050).
  describe("homelab services that run from the deploy copy", () => {
    const targets = [
      {
        app: "loop-state-mcp",
        file: "loop-state-mcp-deploy.yml",
        unit: "loop-state-mcp.service",
        health: "http://127.0.0.1:3791/healthz",
        built: "apps/loop-state-mcp/dist/index.js",
      },
      {
        app: "watchtower-collector",
        file: "watchtower-collector-deploy.yml",
        unit: "watchtower-collector.service",
        health: null,
        built: "apps/watchtower-collector/dist/index.js",
      },
    ];

    it("lists every unit that runs from the deploy copy", () => {
      const fromDeployCopy = apps
        .filter(app => existsSync(join(root, `apps/${app.name}/systemd`)))
        .filter(app =>
          readdirSync(join(root, `apps/${app.name}/systemd`))
            .filter(unit => unit.endsWith(".service"))
            .some(unit => read(`apps/${app.name}/systemd/${unit}`).includes("WorkingDirectory=%h/repos/argus/")),
        )
        .map(app => app.name);
      const covered = [...targets.map(target => target.app), "agent-engine"];
      expect(fromDeployCopy.filter(name => !covered.includes(name))).toEqual([]);
    });

    for (const target of targets) {
      describe(target.file, () => {
        const workflow = () => read(`.github/workflows/${target.file}`);
        const deployJob = () => {
          const text = workflow();
          const start = text.indexOf("\n  deploy:");
          expect(start).toBeGreaterThan(-1);
          return text.slice(start);
        };

        it("moves the deploy copy to origin/deploy and runs deploy.sh from it, not from the job's checkout", () => {
          const job = deployJob();
          expect(job).toContain('cd "$HOME/repos/argus"');
          expect(job).toContain("git fetch --quiet origin deploy");
          expect(job).toContain("git switch --detach origin/deploy");
          const move = job.indexOf("git switch --detach origin/deploy");
          const deploy = job.indexOf(`bash apps/${target.app}/deploy.sh`);
          expect(deploy).toBeGreaterThan(move);
          expect(job.slice(move, deploy)).toContain('cd "$HOME/repos/argus"');
          expect(job).not.toContain("actions/checkout");
          expect(job).not.toContain("--dry-run");
        });

        it("reads the effect back last: the unit restarted after the job began, and the deploy copy holds a build", () => {
          const job = deployJob();
          expect(job).toContain('echo "JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"');
          const last = job.split("\n      - name:").at(-1) ?? "";
          expect(last).toContain("Read");
          expect(last).toContain(target.unit);
          expect(last).toContain("ActiveEnterTimestamp");
          expect(last).toContain("JOB_STARTED_AT");
          expect(last).toContain(target.built);
          if (target.health) expect(last).toContain(target.health);
        });

        it("takes no pull request: its dry run is deploy-dry-run.yml, on a hosted runner (argus#1207)", () => {
          const text = workflow();
          expect(text.split("\njobs:")[0]).not.toContain("pull_request");
          expect(text).not.toMatch(/\n  dry-run:/);
          const dryRun = read(".github/workflows/deploy-dry-run.yml");
          expect(dryRun.split("\njobs:")[0]).toContain("pull_request:");
          expect(dryRun).toContain("runs-on: ubuntu-latest");
          expect(dryRun).toContain(`- app: ${target.app}`);
          expect(dryRun).toContain(`"apps/${target.app}/**"`);
          expect(dryRun).toContain("bash -n apps/${{ matrix.app }}/deploy.sh");
        });
      });
    }
  });

  // The WSL2 targets deploy from the owner's laptop on the `wsl2-deploy` runner
  // (argus#1025, argus-config#1048, #1049, #1050). Each runs its own deploy.sh from the
  // deploy copy at origin/deploy, so the hub approval and the by-hand break-glass path
  // cannot drift apart. The runner takes no pull_request job: it is the owner's machine.
  describe("WSL2 deploy workflows", () => {
    const targets = [
      {
        app: "agent-engine",
        file: "agent-engine-deploy.yml",
        paths: ["apps/agent-engine/**"],
        install: "pnpm install --frozen-lockfile --filter @argus/agent-engine...",
        deploy: "bash apps/agent-engine/deploy.sh\n",
        readBack: "agent-engine.service",
      },
      {
        app: "agent-cli",
        file: "agent-cli-deploy.yml",
        paths: ["apps/agent-cli/**"],
        install: "pnpm install --frozen-lockfile --filter @argus/agent-cli...",
        deploy: "bash apps/agent-cli/deploy.sh\n",
        readBack: ".argus/agent-cli/dist/index.js",
      },
      {
        app: "watchtower-usage-shim",
        file: "watchtower-usage-shim-deploy.yml",
        paths: [
          "apps/watchtower-usage-shim/**",
          "packages/bearer-auth/**",
          "packages/watchtower-contract/**",
        ],
        install: "pnpm install --frozen-lockfile --filter @argus/watchtower-usage-shim...",
        deploy: "bash apps/watchtower-usage-shim/deploy.sh\n",
        readBack: "watchtower-usage-shim.service",
      },
      {
        app: "t3-peer-mcp",
        file: "t3-peer-mcp-wsl2-deploy.yml",
        paths: ["apps/t3-peer-mcp/**"],
        install: "pnpm install --frozen-lockfile --filter @argus/t3-peer-mcp...",
        deploy: "bash apps/t3-peer-mcp/deploy.sh\n",
        readBack: ".argus/t3-peer-mcp/dist",
      },
    ];

    for (const target of targets) {
      describe(target.file, () => {
        const file = `.github/workflows/${target.file}`;
        const workflow = () => read(file);
        const trigger = () => workflow().split("\njobs:")[0];
        const events = () => trigger().slice(trigger().indexOf("\non:"));
        const steps = () => workflow().split("\n      - name:");

        it("deploys on a push to deploy, path-filtered to its target and the workflow itself", () => {
          expect(trigger()).toContain("branches: [deploy]");
          expect(trigger()).not.toContain("branches: [main]");
          for (const path of [...target.paths, file]) expect(trigger(), path).toContain(`"${path}"`);
        });

        it("refuses any ref but deploy, so the owner's replay dispatch cannot name another", () => {
          expect(trigger()).toContain("workflow_dispatch:");
          expect(workflow()).toContain(
            "if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/deploy'",
          );
        });

        it("runs only on the wsl2-deploy runner and takes no pull request", () => {
          expect(workflow()).toContain("runs-on: [self-hosted, wsl2-deploy]");
          expect(workflow().match(/runs-on:/g)).toHaveLength(1);
          expect(events()).not.toMatch(/pull_request/);
          expect(workflow()).not.toMatch(/secrets\./);
        });

        it("deploys one at a time and never cancels one mid-run", () => {
          expect(workflow()).toMatch(
            /\nconcurrency:\n {2}group: \$\{\{ github\.workflow \}\}\n {2}cancel-in-progress: false\n/,
          );
        });

        it("runs the target's own deploy.sh from the deploy copy at origin/deploy", () => {
          expect(workflow()).toContain("git fetch --quiet origin deploy");
          expect(workflow()).toContain("git switch --detach origin/deploy");
          expect(workflow()).toContain("$HOME/repos/argus");
          expect(workflow()).toContain(target.install);
          expect(workflow()).toContain(target.deploy);
          expect(workflow()).not.toContain("--dry-run");
          expect(workflow().indexOf(target.install)).toBeLessThan(workflow().indexOf(target.deploy));
        });

        it("reaches the user systemd manager, which the runner's job environment may not carry", () => {
          expect(workflow()).toContain('echo "XDG_RUNTIME_DIR=/run/user/$(id -u)" >> "$GITHUB_ENV"');
        });

        it("reads the effect back last, not deploy.sh's word for it", () => {
          const last = steps().at(-1) ?? "";
          expect(last).toContain("Read");
          expect(last).toContain(target.readBack);
        });

        it("is guarded by the same checkout check as the break-glass path", () => {
          expect(read(`apps/${target.app}/deploy.sh`)).toContain(guardCall);
        });
      });
    }

    it("loads the WSL2 half of t3-peer-mcp beside, not instead of, the homelab workflow", () => {
      expect(read(".github/workflows/t3-peer-mcp-deploy.yml")).toContain("runs-on: [self-hosted, homelab, deploy]");
      expect(read(".github/workflows/t3-peer-mcp-wsl2-deploy.yml")).not.toContain("homelab");
    });
  });

  // Every deploy.sh is either run by a deploy-branch workflow or named here with the reason
  // it is not, so a new target cannot be left to a hand-run script (argus-config#1048).
  it("accounts for every deploy.sh: a deploy-branch workflow, or a named reason", () => {
    const byHand: Record<string, string> = {};
    const workflows = readdirSync(join(root, ".github/workflows"))
      .filter(file => file.endsWith(".yml"))
      .map(file => read(`.github/workflows/${file}`));
    const unaccounted: string[] = [];
    for (const app of apps) {
      if (!existsSync(join(root, `apps/${app.name}/deploy.sh`)) || app.name in byHand) continue;
      const deploysOnDeploy = workflows.some(
        text =>
          text.split("\njobs:")[0].includes("branches: [deploy]") &&
          text.includes(`apps/${app.name}/**`) &&
          text.includes(`bash apps/${app.name}/deploy.sh`),
      );
      if (!deploysOnDeploy) unaccounted.push(app.name);
    }
    expect(unaccounted).toEqual([]);
  });

  // A Worker added with a wrangler config but no deploy-on-`deploy` workflow would sit
  // behind every promote until someone ran it by hand (argus#982). Each Worker is either
  // wired or named here with the reason it is not.
  it("accounts for every Worker: a deploy workflow, or a named reason it ships by hand", () => {
    const byHand: Record<string, string> = {};
    const workflows = readdirSync(join(root, ".github/workflows"))
      .filter(file => file.endsWith(".yml"))
      .map(file => read(`.github/workflows/${file}`));
    const unaccounted: string[] = [];
    for (const app of readdirSync(join(root, "apps"), { withFileTypes: true })) {
      if (!app.isDirectory() || !existsSync(join(root, `apps/${app.name}/wrangler.jsonc`))) continue;
      if (app.name in byHand) continue;
      const deploysOnDeploy = workflows.some(
        text => text.split("\njobs:")[0].includes("branches: [deploy]") && text.includes(`apps/${app.name}/**`),
      );
      if (!deploysOnDeploy) unaccounted.push(app.name);
    }
    expect(unaccounted).toEqual([]);
  });

  // argus#1066 (argus-config#1048): a version is cut when the owner promotes, one per push
  // to `deploy`, never by a merge to `main`.
  describe("release workflow", () => {
    const release = read(".github/workflows/release.yml");
    const header = release.split("\njobs:")[0];
    // Comments explain the wiring and name the things it avoids; the checks read YAML only.
    const yaml = release
      .split("\n")
      .filter(line => !line.trim().startsWith("#"))
      .join("\n");

    it("runs on a push to deploy and a dispatch, and no longer on main", () => {
      expect(header).toContain("branches: [deploy]");
      expect(header).not.toContain("branches: [main]");
      expect(header).toContain("workflow_dispatch:");
    });

    it("does not use workflow_run, which makes GITHUB_REF the default branch", () => {
      expect(yaml).not.toContain("workflow_run");
    });

    it("refuses a dispatch from any ref but deploy", () => {
      expect(yaml).toContain("if: github.ref == 'refs/heads/deploy'");
    });

    // Two jobs (argus#65, argus-config#1595, rule #1167): `gate` asks whether anything would ship and
    // then whether main's CI on the SHA and the daily full run are green; `release` needs it. No
    // suite runs on the deploy push. A promotion of only chore/docs/ci commits runs no gate and cuts
    // no version.
    const job = (name: string): string => {
      const order = ["gate", "release"];
      const from = yaml.indexOf(`\n  ${name}:`);
      const next = order.slice(order.indexOf(name) + 1).map(other => yaml.indexOf(`\n  ${other}:`)).find(at => at > from);
      return yaml.slice(from, next ?? yaml.length);
    };
    const folded = (text: string): string => text.replace(/\s+/g, " ");

    it("has gate and release jobs, and no job that runs a suite", () => {
      const jobs = [...yaml.slice(yaml.indexOf("\njobs:")).matchAll(/^ {2}([\w-]+):$/gm)].map(match => match[1]);
      expect(jobs).toEqual(["gate", "release"]);
      expect(yaml).not.toMatch(/run: scripts\/ci\.sh/);
      expect(yaml).not.toContain("release-proof");
    });

    it("tests first in a job named for what it proves, and releases only if it passes", () => {
      const gate = job("gate");
      const releaseJob = job("release");
      expect(gate).toContain("name: Test before release (main CI plus the daily full run)");
      expect(gate).toContain("if: github.ref == 'refs/heads/deploy'");
      expect(releaseJob).toMatch(/\n {4}needs: gate\n/);
      expect(releaseJob).toContain("name: Release\n");
      expect(releaseJob).toContain("github.ref == 'refs/heads/deploy'");
    });

    // argus#1168: a promotion with nothing releasable costs no test and no version.
    it("asks scripts/ci/release-needed.sh first, from a full-history checkout", () => {
      const gate = job("gate");
      expect(gate).toMatch(/uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0\n/);
      expect(gate).toMatch(/id: anything\n {8}run: bash scripts\/ci\/release-needed\.sh\n/);
      expect(gate.indexOf("release-needed.sh")).toBeLessThan(gate.indexOf("release-gate.sh"));
      expect(gate).toContain("release: ${{ steps.anything.outputs.release }}");
    });

    it("skips the gate and the release when nothing is releasable", () => {
      expect(folded(job("gate"))).toContain("if: steps.anything.outputs.release == 'true' run: bash scripts/ci/release-gate.sh");
      expect(folded(job("release"))).toContain("needs.gate.outputs.release == 'true'");
    });

    // argus#65: main's CI on the exact promoted SHA (a scoped run counts) plus a daily full run
    // under 24 hours old. The vendored script hard-codes nothing, so the workflow names what is
    // this repo's: the CI workflow, the daily workflow file and the job that reports the verdict.
    it("runs scripts/ci/release-gate.sh with this repo's workflow names", () => {
      const gate = job("gate");
      const step = gate.slice(gate.indexOf("bash scripts/ci/release-gate.sh"));
      expect(step).toMatch(/env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n/);
      expect(step).toMatch(/RELEASE_GATE_CI_WORKFLOW: CI\n/);
      expect(step).toMatch(/RELEASE_GATE_DAILY_WORKFLOW: daily-full\.yml\n/);
      expect(step).toMatch(/RELEASE_GATE_DAILY_JOBS: Daily full suite passed\n/);
      expect(gate).toMatch(/permissions:\n {6}contents: read\n {6}actions: read\n/);
    });

    it("vendors the release scripts: a lock beside them names the argus-config source", () => {
      const lock = read("scripts/ci/release-scripts.lock");
      expect(lock).toMatch(/^source deanjstone\/argus-config [0-9a-f]{40}$/m);
      for (const name of ["release-gate.sh", "release-proof.sh", "release-scripts-check.sh", "release-with-retry.sh"]) {
        expect(lock).toMatch(new RegExp(`^[0-9a-f]{64}  ${name}$`, "m"));
      }
    });

    it("releases only after the gate passed", () => {
      const releaseJob = folded(job("release"));
      expect(releaseJob).toContain("needs: gate");
      expect(releaseJob).toContain("needs.gate.outputs.release == 'true'");
      expect(releaseJob).not.toContain("needs.test");
    });

    it("releases only the SHA the gate vouched for", () => {
      expect(yaml).toContain('"$(git rev-parse HEAD)" == "${GITHUB_SHA}"');
      expect(yaml).toContain("steps.tested.outputs.current == 'true'");
    });

    it("checks out and fast-forwards deploy, not main", () => {
      expect(yaml).toContain("ref: deploy");
      expect(yaml).toContain("git pull --ff-only origin deploy");
      // The proof step names main in prose; nothing may check main out or pull from it.
      expect(yaml).not.toMatch(/ref: main|origin main|origin\/main/);
    });

    it("does not filter on the push's commit list, which holds 20 commits at most", () => {
      expect(yaml).not.toContain("github.event.commits");
      expect(yaml).not.toContain("github.event.forced");
    });

    it("queues releases in one group and never cancels one", () => {
      expect(yaml).toMatch(/concurrency:\n {2}group: release\n {2}cancel-in-progress: false/);
    });

    it("releases every track, nested workspaces included", () => {
      const tracks = [...readdirSync(join(root, "apps")).map(name => `apps/${name}`), ...readdirSync(join(root, "packages")).map(name => `packages/${name}`)]
        .filter(dir => existsSync(join(root, dir, ".releaserc.json")))
        .sort();
      expect(tracks.length).toBeGreaterThanOrEqual(6);
      const listed = [...yaml.matchAll(/^ {12}((?:apps|packages)\/[\w-]+)$/gm)].map(match => match[1]).sort();
      expect(listed).toEqual(tracks);
    });
  });

  // argus#1168 (argus-config#1167): a release or asset created from `main` is finalised
  // before the owner's Approve. The ecosystem manifest asset is published on promotion too.
  describe("ecosystem-release workflow", () => {
    const workflow = read(".github/workflows/ecosystem-release.yml");
    const header = workflow.split("\njobs:")[0];
    const yaml = workflow
      .split("\n")
      .filter(line => !line.trim().startsWith("#"))
      .join("\n");

    it("runs on a push to deploy and a dispatch, never on main", () => {
      const trigger = yaml.slice(yaml.indexOf("\non:"), yaml.indexOf("\npermissions:"));
      expect(trigger).toContain("branches: [deploy]");
      expect(trigger).not.toContain("main");
      expect(trigger).toContain("workflow_dispatch:");
      expect(trigger).toContain('"ecosystem/manifest.json"');
      expect(trigger).toContain('".github/workflows/ecosystem-release.yml"');
    });

    it("refuses a dispatch from any ref but deploy", () => {
      expect(yaml).toContain("if: github.ref == 'refs/heads/deploy'");
    });

    it("says in its header that the owner's promotion publishes it", () => {
      expect(header).toContain("promotion");
      expect(header).toContain("deploy");
    });
  });

  it("has no workflow that writes contents from a push to main", () => {
    const offenders = readdirSync(join(root, ".github/workflows"))
      .filter(file => file.endsWith(".yml"))
      .filter(file => {
        const text = read(`.github/workflows/${file}`);
        const trigger = text.split("\njobs:")[0];
        return /\n {2}push:\n(?: {4}[^\n]*\n)*? {4}branches:[^\n]*\bmain\b/.test(trigger) && text.includes("contents: write");
      });
    expect(offenders).toEqual([]);
  });

  describe("semantic-release config", () => {
    const configs = [
      ".releaserc.json",
      ...readdirSync(join(root, "apps")).map(name => `apps/${name}/.releaserc.json`),
      ...readdirSync(join(root, "packages")).map(name => `packages/${name}/.releaserc.json`),
    ].filter(file => existsSync(join(root, file)));
    // `deploy` is fast-forwarded from `main`, so a commit made on it would fork the two.
    const commitsBack = ["@semantic-release/git", "@semantic-release/changelog", "@semantic-release/npm"];

    it("finds the root and the app tracks", () => {
      expect(configs).toContain(".releaserc.json");
      expect(configs.length).toBeGreaterThan(6);
    });

    it.each(configs)("%s releases from deploy and commits nothing back", file => {
      const config = JSON.parse(read(file)) as { branches: string[]; plugins: Array<string | [string, unknown]> };
      expect(config.branches).toEqual(["deploy"]);
      const plugins = config.plugins.map(plugin => (typeof plugin === "string" ? plugin : plugin[0]));
      expect(plugins).toEqual([
        "@semantic-release/commit-analyzer",
        "@semantic-release/release-notes-generator",
        "@semantic-release/github",
      ]);
      for (const plugin of commitsBack) expect(read(file)).not.toContain(`"${plugin}"`);
    });

    it("keeps the commit-back plugins out of every package.json", () => {
      const manifests = [
        "package.json",
        ...readdirSync(join(root, "apps")).map(name => `apps/${name}/package.json`),
        ...readdirSync(join(root, "packages")).map(name => `packages/${name}/package.json`),
      ].filter(file => existsSync(join(root, file)));
      const offenders = manifests.filter(file => commitsBack.some(plugin => read(file).includes(`"${plugin}"`)));
      expect(offenders).toEqual([]);
    });
  });
});

// Where each deploy workflow runs (homelab#391). A job that only talks to Cloudflare or GitHub
// with a repo secret needs nothing from the box, so it runs on a GitHub-hosted runner, inside the
// free private-repo minutes, and takes no homelab slot in a promotion's burst. A job that
// installs onto the host keeps the homelab runner.
// vitest's hookTimeout defaults to 10 s and is separate from testTimeout. The scripts
// suite raised only testTimeout, so a beforeEach that builds a git fixture timed out on
// a loaded runner while the test body had 30 s (argus#1169, same class as #1114).
describe("the scripts suite timeouts", () => {
  const flagSeconds = (command: string, flag: string): number | undefined => {
    const match = command.match(new RegExp(`--${flag}=(\\d+)`));
    return match ? Number(match[1]) : undefined;
  };
  const command = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts["test:scripts"];

  it("gives hooks at least the time a test gets", () => {
    const testTimeout = flagSeconds(command, "testTimeout");
    const hookTimeout = flagSeconds(command, "hookTimeout");
    expect(testTimeout, command).toBeDefined();
    expect(hookTimeout, command).toBeDefined();
    expect(hookTimeout).toBeGreaterThanOrEqual(testTimeout as number);
  });
});

describe("deploy workflows that need no host run on GitHub-hosted runners", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const hosted = [
    "watchtower-deploy-worker.yml",
    "watchtower-deploy.yml",
    "ecosystem-release.yml",
    "release.yml",
  ];
  const hostDeploys = [
    "loop-state-mcp-deploy.yml",
    "watchtower-collector-deploy.yml",
    "t3-peer-mcp-deploy.yml",
  ];

  for (const file of hosted) {
    it(`${file} runs every job on a GitHub-hosted runner (argus#1207: the repository is public)`, () => {
      const runners = [...read(`.github/workflows/${file}`).matchAll(/^\s+runs-on: (.+)$/gm)].map(match => match[1]);
      expect(runners.length).toBeGreaterThan(0);
      expect(runners.every(runner => runner === "ubuntu-latest")).toBe(true);
    });
  }

  for (const file of hostDeploys) {
    it(`${file} has one job, on the homelab deploy runner (homelab#459)`, () => {
      const runners = [...read(`.github/workflows/${file}`).matchAll(/^\s+runs-on: (.+)$/gm)].map(match => match[1]);
      expect(runners).toEqual(["[self-hosted, homelab, deploy]"]);
    });
  }
});
