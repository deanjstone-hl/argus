import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// What keeps this repository safe to publish (argus#1207, map homelab#478; the models are
// deanjstone/sys-admin tests/bats/scripts/public-safe.bats and deanjstone/skills
// tests/test_public_safe.py).
//
// The repository goes public through a fresh-history cutover, so a pull request from a fork
// runs its workflows on this repository's behalf and every file is world-readable. These
// tests pin the rules:
//   - jobs run on GitHub-hosted `ubuntu-latest`; the only other runners allowed are
//     `[self-hosted, homelab, deploy]` and `[self-hosted, wsl2-deploy]`, and only in a workflow
//     that a push to `deploy` (or a dispatch, which needs write access) alone starts, in a job
//     that refuses any other ref (GitHub, secure use of Actions: self-hosted runners "should
//     almost never be used for public repositories"; the fork-approval policy does not stop a
//     fork's pull request reaching one);
//   - no `pull_request_target`, no secret in a pull-request workflow beyond the read-only token;
//   - no value in an Actions secret (argus#59): a workflow reads GITHUB_TOKEN and the one
//     Secrets Manager token BWS_ACCESS_TOKEN, handed only to bitwarden/sm-action pinned by a full
//     commit SHA, which reads the values from the `actions` project of Secrets Manager. The one
//     exception is SKILLS_READ_TOKEN (see skillsReadTokenException);
//   - no private value in the tree (scripts/scrub-scan.sh).
// Workflows are read as text, as in deploy-branch.test.ts, so no YAML parser is needed. Any
// value that looks private is built at run time, so this file holds none.

const root = fileURLToPath(new URL("..", import.meta.url));
const workflows = join(root, ".github", "workflows");
const haveGitleaks = ["gitleaks", "jq"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

// argus#59: SKILLS_READ_TOKEN is the one repository secret a workflow may still read. It is a
// fine-grained PAT for the two private repositories the ecosystem-skills check reads; it is not
// set (the check skips), so there is no Secrets Manager key, and no id, to map until the owner
// issues the token. Delete this exception when ecosystem-skills.yml reads it through sm-action.
const skillsReadTokenException = { workflow: "ecosystem-skills.yml", secret: "SKILLS_READ_TOKEN" };

const smActionPin = /uses:\s*bitwarden\/sm-action@[0-9a-f]{40}(?:\s+#.*)?$/;

// Every `secrets.X` a workflow reads, and whether each use of BWS_ACCESS_TOKEN is the access_token
// input of a bitwarden/sm-action step pinned by a full SHA.
function secretProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  const lines = code(text).split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      const secret = match[1];
      if (secret === "GITHUB_TOKEN") continue;
      if (secret === "BWS_ACCESS_TOKEN") {
        const inputLine = /^\s+access_token:\s*\$\{\{ secrets\.BWS_ACCESS_TOKEN \}\}\s*$/.test(line);
        // The `with:` block of the step: back to the `- ` that opens it must hold the pinned `uses:`.
        let start = index;
        while (start > 0 && !/^\s+- /.test(lines[start])) start -= 1;
        const step = lines.slice(start, index + 1).join("\n");
        const pinned = step.split("\n").some((stepLine) => smActionPin.test(stepLine.replace(/^\s+- /, "  ")));
        if (!inputLine || !pinned) problems.push(`${name}: BWS_ACCESS_TOKEN used other than as the access_token of a bitwarden/sm-action step pinned by a full commit SHA`);
      } else if (!(name === skillsReadTokenException.workflow && secret === skillsReadTokenException.secret)) {
        problems.push(`${name}: reads the repository secret ${secret} (read it from Secrets Manager through sm-action)`);
      }
    }
  });
  return problems;
}

const allowedSelfHosted = ["[self-hosted, homelab, deploy]", "[self-hosted, wsl2-deploy]"];

// The file without comment lines, so a comment may name what a workflow avoids.
const code = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

// The top-level keys under `on:` (push, pull_request, ...).
function onKeys(text: string): string[] {
  const keys: string[] = [];
  let inOn = false;
  for (const line of code(text).split("\n")) {
    if (/^on:/.test(line)) {
      inOn = true;
      continue;
    }
    if (inOn && /^\S/.test(line)) inOn = false;
    const match = /^ {2}([A-Za-z_]+):/.exec(line);
    if (inOn && match) keys.push(match[1]);
  }
  return keys;
}

// The `branches:` list of the push trigger, e.g. "[deploy]".
function pushBranches(text: string): string {
  const lines = code(text).split("\n");
  const start = lines.findIndex((line) => /^ {2}push:/.test(line));
  if (start === -1) return "";
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break;
    const match = /^ {4}branches: (.+)$/.exec(line);
    if (match) return match[1].trim();
  }
  return "";
}

// The `if:` lines of every job whose runs-on is one of the self-hosted label sets.
function selfHostedJobsRefuseOtherRefs(text: string): boolean {
  const blocks = code(text).split(/\n {2}(?=[A-Za-z0-9_-]+:\n)/);
  return blocks
    .filter((block) => /runs-on: \[self-hosted/.test(block))
    .every((block) => /\n {4}if: .*github\.ref == 'refs\/heads\/deploy'/.test(`\n${block}`));
}

// One line per violation of the rules above; empty when the directory passes.
function checkWorkflows(dir: string): string[] {
  const problems: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".yml"))) {
    const text = readFileSync(join(dir, name), "utf8");
    const body = code(text);
    if (/pull_request_target/.test(body)) problems.push(`${name}: pull_request_target`);
    if (/CI_RUNS_ON|vars\.[A-Z_]*RUNS_ON|runner\.environment/.test(body)) {
      problems.push(`${name}: a runner-selecting variable or runner.environment test`);
    }
    if (/uses:\s*deanjstone\//.test(body)) problems.push(`${name}: uses an action or workflow from a repository of the owner`);
    problems.push(...secretProblems(name, text));

    const keys = onKeys(text);
    const runners = [...body.matchAll(/^\s*runs-on:\s*(.*\S)\s*$/gm)].map((match) => match[1]);
    if (runners.length === 0) problems.push(`${name}: no runs-on`);
    for (const runner of runners) {
      if (runner === "ubuntu-latest") continue;
      if (!allowedSelfHosted.includes(runner)) {
        problems.push(`${name}: runs-on '${runner}'`);
        continue;
      }
      const onlyDeployPush = keys.every((key) => key === "push" || key === "workflow_dispatch") && pushBranches(text) === "[deploy]";
      if (!onlyDeployPush) problems.push(`${name}: a self-hosted job in a workflow that a push to deploy alone does not start`);
      if (!selfHostedJobsRefuseOtherRefs(text)) problems.push(`${name}: a self-hosted job that does not refuse a ref other than deploy`);
    }

    if (keys.includes("pull_request")) {
      const secrets = [...body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]).filter((secret) => secret !== "GITHUB_TOKEN");
      if (secrets.length > 0) problems.push(`${name}: a pull-request workflow reads a secret`);
      if (!/^permissions:\n {2}contents: read$/m.test(body)) {
        problems.push(`${name}: a pull-request workflow without top-level permissions: contents: read`);
      }
    }
  }
  return problems;
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function planted(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "public-safe-"));
  scratch.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("the workflows in this repository", () => {
  it("are there to check", () => {
    expect(readdirSync(workflows).filter((file) => file.endsWith(".yml")).length).toBeGreaterThan(0);
  });

  it("pass the public-repository rules", () => {
    expect(checkWorkflows(workflows)).toEqual([]);
  });

  it("start nothing from a pull request except hosted, secret-free jobs", () => {
    const started = readdirSync(workflows)
      .filter((file) => file.endsWith(".yml"))
      .filter((file) => onKeys(readFileSync(join(workflows, file), "utf8")).includes("pull_request"));
    expect(started).toEqual(expect.arrayContaining(["ci.yml", "deploy-dry-run.yml", "readme-guard.yml"]));
    for (const file of started) {
      expect(code(readFileSync(join(workflows, file), "utf8")), file).not.toMatch(/self-hosted/);
    }
  });

  it("keep every host job in a workflow named for a deploy", () => {
    const hostWorkflows = readdirSync(workflows)
      .filter((file) => file.endsWith(".yml"))
      .filter((file) => /self-hosted/.test(code(readFileSync(join(workflows, file), "utf8"))));
    expect(hostWorkflows.length).toBeGreaterThan(0);
    for (const file of hostWorkflows) expect(file, file).toMatch(/deploy\.yml$/);
  });

  it("pin the gitleaks release the scan job installs by its published sha256, not a placeholder", () => {
    // gitleaks 8.30.1 linux_x64, from gitleaks_8.30.1_checksums.txt. A scrub once replaced it
    // with a placeholder and broke CI (argus#1207).
    const ci = readFileSync(join(workflows, "ci.yml"), "utf8");
    expect(ci).toContain("GITLEAKS_VERSION: 8.30.1");
    expect(ci).toContain("GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb");
  });

  it("have no use of the host-pnpm action: nothing here runs on a runner that needs it", () => {
    for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
      expect(code(readFileSync(join(workflows, file), "utf8")), file).not.toContain("actions/host-pnpm");
    }
  });
});

describe("the workflow checker itself: each rule fails on a planted breach", () => {
  const header = "name: x\n";
  const hosted = "jobs:\n  a:\n    runs-on: ubuntu-latest\n";
  it("rejects pull_request_target", () => {
    const dir = planted({ "bad.yml": `${header}on:\n  pull_request_target:\n${hosted}` });
    expect(checkWorkflows(dir).join("\n")).toContain("pull_request_target");
  });

  it("rejects a self-hosted job in a workflow a pull request also starts", () => {
    const text = `${header}on:\n  pull_request:\n  push:\n    branches: [deploy]\npermissions:\n  contents: read\njobs:\n  a:\n    if: github.ref == 'refs/heads/deploy'\n    runs-on: [self-hosted, homelab, deploy]\n`;
    expect(checkWorkflows(planted({ "bad.yml": text })).join("\n")).toContain("self-hosted job");
  });

  it("rejects a self-hosted job that a push to main starts", () => {
    const text = `${header}on:\n  push:\n    branches: [main]\njobs:\n  a:\n    if: github.ref == 'refs/heads/deploy'\n    runs-on: [self-hosted, homelab, deploy]\n`;
    expect(checkWorkflows(planted({ "bad.yml": text }))).not.toEqual([]);
  });

  it("rejects a self-hosted job that does not refuse a ref other than deploy", () => {
    const text = `${header}on:\n  push:\n    branches: [deploy]\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: [self-hosted, wsl2-deploy]\n`;
    expect(checkWorkflows(planted({ "bad.yml": text })).join("\n")).toContain("does not refuse");
  });

  it("accepts a self-hosted deploy job that only a push to deploy or a dispatch starts", () => {
    const text = `${header}on:\n  push:\n    branches: [deploy]\n  workflow_dispatch:\njobs:\n  a:\n    if: github.ref == 'refs/heads/deploy'\n    runs-on: [self-hosted, homelab, deploy]\n`;
    expect(checkWorkflows(planted({ "ok.yml": text }))).toEqual([]);
  });

  it("rejects any other runner, the CI_RUNS_ON variable and runner.environment", () => {
    const other = `${header}on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: windows-latest\n`;
    expect(checkWorkflows(planted({ "bad.yml": other }))).not.toEqual([]);
    const variable = `${header}on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: \${{ fromJSON(vars.CI_RUNS_ON || '"ubuntu-latest"') }}\n`;
    expect(checkWorkflows(planted({ "bad.yml": variable }))).not.toEqual([]);
  });

  it("rejects a secret in a pull-request workflow and a missing read-only token", () => {
    const secret = `${header}on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      T: \${{ secrets.SOME_TOKEN }}\n`;
    expect(checkWorkflows(planted({ "bad.yml": secret })).join("\n")).toContain("reads a secret");
    const noPermissions = `${header}on:\n  pull_request:\n${hosted}`;
    expect(checkWorkflows(planted({ "bad.yml": noPermissions })).join("\n")).toContain("permissions");
  });

  it("rejects an action from a repository of the owner", () => {
    const uses = `${header}on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: deanjstone/argus/.github/actions/x@v1\n`;
    expect(checkWorkflows(planted({ "bad.yml": uses }))).not.toEqual([]);
  });

  describe("the Secrets Manager token (argus#59)", () => {
    const pin = "bitwarden/sm-action@1238aae8fc64b212641190a9227c8a734ab1a793 # v3.0.1";
    const smStep = (uses: string, tokenLine = "access_token: ${{ secrets.BWS_ACCESS_TOKEN }}") =>
      `${header}on:\n  push:\n    branches: [deploy]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Read\n        uses: ${uses}\n        with:\n          ${tokenLine}\n          secrets: |\n            00000000-0000-4000-8000-000000000001 > X\n`;

    it("accepts it as the access_token of a bitwarden/sm-action step pinned by a full commit SHA", () => {
      expect(checkWorkflows(planted({ "ok.yml": smStep(pin) }))).toEqual([]);
    });

    it("rejects it in an env block, in a run step, or on an sm-action that is not pinned by a SHA", () => {
      const env = `${header}on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      T: \${{ secrets.BWS_ACCESS_TOKEN }}\n`;
      expect(checkWorkflows(planted({ "bad.yml": env })).join("\n")).toContain("BWS_ACCESS_TOKEN");
      const tag = smStep("bitwarden/sm-action@v3");
      expect(checkWorkflows(planted({ "bad.yml": tag })).join("\n")).toContain("BWS_ACCESS_TOKEN");
      const other = smStep("some/other-action@1238aae8fc64b212641190a9227c8a734ab1a793");
      expect(checkWorkflows(planted({ "bad.yml": other })).join("\n")).toContain("BWS_ACCESS_TOKEN");
      const renamed = smStep(pin, "other_input: ${{ secrets.BWS_ACCESS_TOKEN }}");
      expect(checkWorkflows(planted({ "bad.yml": renamed })).join("\n")).toContain("BWS_ACCESS_TOKEN");
    });

    it("rejects it in a workflow a pull request starts", () => {
      const pr = smStep(pin).replace("on:\n  push:\n    branches: [deploy]\n", "on:\n  pull_request:\npermissions:\n  contents: read\n");
      expect(checkWorkflows(planted({ "bad.yml": pr })).join("\n")).toContain("reads a secret");
    });

    it("rejects any other repository secret, whatever workflow reads it", () => {
      const other = `${header}on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      T: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`;
      expect(checkWorkflows(planted({ "bad.yml": other })).join("\n")).toContain("CLOUDFLARE_API_TOKEN");
      const elsewhere = `${header}on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      T: \${{ secrets.SKILLS_READ_TOKEN }}\n`;
      expect(checkWorkflows(planted({ "bad.yml": elsewhere })).join("\n")).toContain("SKILLS_READ_TOKEN");
    });
  });
});

describe("private values", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("name their Secrets Manager keys in the collector .env.example and hold no value", () => {
    const text = read("apps/watchtower-collector/.env.example");
    for (const key of ["ARGUS_CLOUDFLARE_ACCOUNT_ID", "ARGUS_CLOUDFLARE_ZONE_ID", "ARGUS_D1_WATCHTOWER_DATABASE_ID"]) {
      expect(text, key).toContain(`# BWS secret ${key}:`);
    }
    expect(text).toMatch(/^CLOUDFLARE_ACCOUNT_ID=$/m);
    expect(text).toMatch(/^CLOUDFLARE_ZONE_ID=$/m);
    expect(text).toMatch(/^D1_DATABASES=argus-watchtower:$/m);
  });

  it("read the collector's private values from Secrets Manager by key name", () => {
    const deploy = read("apps/watchtower-collector/deploy.sh");
    for (const key of [
      "ARGUS_TAILSCALE_IP_HOMELAB",
      "ARGUS_TAILSCALE_IP_WSL2",
      "ARGUS_CLOUDFLARE_ACCOUNT_ID",
      "ARGUS_CLOUDFLARE_ZONE_ID",
      "ARGUS_D1_WATCHTOWER_DATABASE_ID",
    ]) {
      expect(deploy, key).toContain(key);
    }
  });

  it("keep the Worker's database id out of wrangler.jsonc, behind scripts/with-d1-id.sh", () => {
    const wrangler = read("apps/watchtower/wrangler.jsonc");
    expect(wrangler).toContain('"database_id": "00000000-0000-4000-8000-0000000000d1"');
    expect(read("apps/watchtower/package.json")).toContain("bash scripts/with-d1-id.sh wrangler deploy");
    expect(read(".github/workflows/watchtower-deploy-worker.yml")).toMatch(/^\s+[0-9a-f-]{36} > WATCHTOWER_D1_DATABASE_ID$/m);
  });

  it(".env is ignored at the root, and the template is not", () => {
    const lines = read(".gitignore").split("\n");
    expect(lines).toContain("/.env");
    expect(lines).toContain("!/.env.example");
  });

  it("have a scrub config and script", () => {
    expect(read(".gitleaks.toml")).toContain("[[rules]]");
    expect(readFileSync(join(root, "scripts", "scrub-scan.sh"), "utf8")).toContain("scrub-scan: pass");
  });

  it("have the licence: Apache-2.0, and a NOTICE naming the owner and the year", () => {
    expect(read("LICENSE")).toContain("Apache License");
    expect(read("LICENSE")).toContain("Version 2.0, January 2004");
    expect(read("NOTICE")).toMatch(/Copyright 2026 Dean Stone/);
  });

  it("scripts/private-value.sh prints a set variable and fails with the key name when nothing supplies it", () => {
    const script = join(root, "scripts", "private-value.sh");
    const set = spawnSync("bash", [script, "ARGUS_TAILSCALE_IP_WSL2"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", ARGUS_TAILSCALE_IP_WSL2: "planted" },
    });
    expect(set.status).toBe(0);
    expect(set.stdout.trim()).toBe("planted");
    const unset = spawnSync("bash", [script, "ARGUS_TAILSCALE_IP_WSL2"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
    });
    expect(unset.status).not.toBe(0);
    expect(unset.stderr).toContain("ARGUS_TAILSCALE_IP_WSL2");
  });
});

// The scrub scan needs gitleaks and jq (the CI job installs gitleaks).
describe.skipIf(!haveGitleaks)("the scrub scan", () => {
  const scan = (...args: string[]) =>
    spawnSync("bash", [join(root, "scripts", "scrub-scan.sh"), ...args], { encoding: "utf8", cwd: root });

  it("finds nothing in the tree at HEAD", () => {
    const result = scan();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("scrub-scan: pass (0 findings)");
  });

  it("passes a clean directory, placeholders and systemd instances", () => {
    const clean = planted({ "a.md": "nothing private here, write to owner@example.com, ssh git@github.com, postgres@15-main.service\n" });
    expect(scan(clean).status).toBe(0);
    const placeholders = planted({ "p.md": "100.64.0.2 box.tailnet-example.ts.net 00000000-0000-4000-8000-000000000001\n" });
    expect(scan(placeholders).status).toBe(0);
  });

  it("fails each private value kind and never prints the value", () => {
    // Built from parts so this file holds no private-looking value itself.
    const dot = ".";
    const values: Record<string, string> = {
      "tailnet-ip": ["100", "97", "96", "95"].join(dot),
      "lan-ip": ["192", "168", "7", "9"].join(dot),
      "tailnet-hostname": `box${dot}${["tail1a2b3", "ts", "net"].join(dot)}`,
      "personal-email": `someone@${["mail", "invalid-tld-example", "org"].join(dot)}`,
      "cloudflare-id": "ab".repeat(16),
      "access-team-domain": `team-xxxx${dot}${["cloudflareaccess", "com"].join(dot)}`,
    };
    for (const [rule, value] of Object.entries(values)) {
      const result = scan(planted({ "leak.txt": `value ${value}\n` }));
      expect(result.status, rule).toBe(1);
      expect(result.stdout, rule).toContain(rule);
      expect(result.stdout + result.stderr, rule).not.toContain(value);
    }
  });
});
