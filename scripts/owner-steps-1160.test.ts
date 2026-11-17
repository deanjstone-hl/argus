import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/owner-steps/1160.sh is argus/1160's live step: clone the ops-hub deploy copy and
// enable its promotion card, approved as one command. The script runs against a scratch
// HOME with fake git, systemctl, curl and hostname on PATH, so nothing live is touched.

const script = fileURLToPath(new URL("owner-steps/1160.sh", import.meta.url));
const code = readFileSync(script, "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

const SECRET = "s3cret-sentinel-value";
const ENV_REL = "repos/argus/apps/ops-hub/.env";

const FAKES: Record<string, string> = {
  hostname: `echo "\${FAKE_HOSTNAME:-homelab}"`,
  systemctl: `echo "systemctl $*" >> "$FAKE_LOG"
case "$*" in
  *is-active*) echo active ;;
esac
exit 0`,
  curl: `echo "curl $*" >> "$FAKE_LOG"
echo '{"ok":true}'
exit "\${FAKE_CURL_STATUS:-0}"`,
  sleep: `exit 0`,
  git: `echo "git $*" >> "$FAKE_LOG"
args=("$@")
if [ "\${args[0]}" = "-C" ]; then dir="\${args[1]}"; args=("\${args[@]:2}"); fi
case "\${args[*]}" in
  "clone "*) mkdir -p "\${args[2]}/.git" ;;
  "remote get-url origin")
    [ -d "$dir/.git" ] || { echo "fatal: not a git repository" >&2; exit 128; }
    echo "git@github.com:deanjstone/ops-hub.git" ;;
  "ls-remote --exit-code --heads "*" deploy") exit "\${FAKE_DEPLOY_STATUS:-2}" ;;
  "ls-remote "*) exit "\${FAKE_LSREMOTE_STATUS:-0}" ;;
  "status --porcelain"*) ;;
esac
exit 0`,
};

type Scratch = { home: string; bin: string; log: string; envFile: string };

const makeScratch = (envBody: string | null): Scratch => {
  const root = mkdtempSync(join(tmpdir(), "owner-steps-1160-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(FAKES)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const envFile = join(home, ENV_REL);
  mkdirSync(join(envFile, ".."), { recursive: true });
  if (envBody !== null) {
    writeFileSync(envFile, envBody, { mode: 0o600 });
    chmodSync(envFile, 0o600);
  }
  return { home, bin, log: join(root, "calls.log"), envFile };
};

const defaultEnv = (promotion: string | null = "deanjstone/homelab,deanjstone/atto1,deanjstone/skills") =>
  [
    "NOTICE_BOARD_PORT=3790",
    `OPS_HUB_API_TOKEN=${SECRET}`,
    ...(promotion === null ? [] : [`OPS_HUB_PROMOTION_REPOS=${promotion}`]),
    "OPS_HUB_OWNER_EMAIL=owner@example.invalid",
    "",
  ].join("\n");

const run = (scratch: Scratch, args: string[], extra: Record<string, string> = {}) => {
  writeFileSync(scratch.log, "", { flag: "a" });
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${scratch.bin}:/usr/bin:/bin`,
      HOME: scratch.home,
      FAKE_LOG: scratch.log,
      ...extra,
    },
  });
};

const calls = (scratch: Scratch) => (existsSync(scratch.log) ? readFileSync(scratch.log, "utf8") : "");
const output = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`;
const withoutKey = (body: string) =>
  body
    .split("\n")
    .filter((line) => !line.startsWith("OPS_HUB_PROMOTION_REPOS="))
    .join("\n");
const keyLine = (body: string) => body.split("\n").find((line) => line.startsWith("OPS_HUB_PROMOTION_REPOS="));

describe("owner-steps/1160.sh", () => {
  it("is executable", () => {
    expect(() => accessSync(script, constants.X_OK)).not.toThrow();
  });

  it.each([["--live"], ["--dry-run", "extra"], ["x"]])("exits 2 on arguments %j", (...args) => {
    const scratch = makeScratch(defaultEnv());
    const result = run(scratch, args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage/);
    expect(calls(scratch)).toBe("");
  });

  it.each([[[]], [["--dry-run"]]])("refuses to run on any host but homelab (%j)", (args) => {
    const scratch = makeScratch(defaultEnv());
    const before = readFileSync(scratch.envFile, "utf8");
    const result = run(scratch, args, { FAKE_HOSTNAME: "LNV-LGN5" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/homelab/);
    expect(calls(scratch)).toBe("");
    expect(readFileSync(scratch.envFile, "utf8")).toBe(before);
    expect(existsSync(join(scratch.home, "repos/ops-hub"))).toBe(false);
  });

  describe("--dry-run", () => {
    it("prints each action and changes nothing", () => {
      const scratch = makeScratch(defaultEnv());
      const before = readFileSync(scratch.envFile, "utf8");
      const result = run(scratch, ["--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/step 1[^\n]*clone/i);
      expect(result.stdout).toMatch(/step 2[^\n]*OPS_HUB_PROMOTION_REPOS/);
      expect(result.stdout).toMatch(/step 3[^\n]*restart/i);
      expect(result.stdout).toMatch(/step 4[^\n]*healthz/i);
      expect(result.stdout).toMatch(/dry run/i);
      expect(readFileSync(scratch.envFile, "utf8")).toBe(before);
      expect(existsSync(join(scratch.home, "repos/ops-hub"))).toBe(false);
      expect(calls(scratch)).not.toMatch(/clone|restart|healthz|switch/);
      expect(output(result)).not.toContain(SECRET);
    });
  });

  describe("pre-flight", () => {
    it("stops, changing nothing, when the .env is missing", () => {
      const scratch = makeScratch(null);
      const result = run(scratch, []);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED/);
      expect(result.stderr).toMatch(/nothing was changed/);
      expect(calls(scratch)).not.toMatch(/clone|restart/);
    });

    it("stops when the .env has no OPS_HUB_PROMOTION_REPOS line", () => {
      const scratch = makeScratch(defaultEnv(null));
      const before = readFileSync(scratch.envFile, "utf8");
      const result = run(scratch, []);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED/);
      expect(readFileSync(scratch.envFile, "utf8")).toBe(before);
      expect(calls(scratch)).not.toMatch(/clone|restart/);
    });

    it("stops when the value is quoted, which the script will not rewrite", () => {
      const scratch = makeScratch(defaultEnv('"deanjstone/homelab"'));
      const result = run(scratch, []);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED/);
    });

    it("stops when GitHub cannot be reached over ssh", () => {
      const scratch = makeScratch(defaultEnv());
      const result = run(scratch, [], { FAKE_LSREMOTE_STATUS: "128" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED/);
      expect(calls(scratch)).not.toMatch(/clone|restart/);
    });

    it("stops when ~/repos/ops-hub exists but is not a checkout of deanjstone/ops-hub", () => {
      const scratch = makeScratch(defaultEnv());
      mkdirSync(join(scratch.home, "repos/ops-hub"), { recursive: true });
      const result = run(scratch, []);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED/);
      expect(calls(scratch)).not.toMatch(/restart/);
    });
  });

  describe("live run (fakes)", () => {
    it("clones, adds the repo to the one key, restarts and reads /healthz back", () => {
      const scratch = makeScratch(defaultEnv());
      const before = readFileSync(scratch.envFile, "utf8");
      const result = run(scratch, []);
      expect(result.status).toBe(0);

      const after = readFileSync(scratch.envFile, "utf8");
      expect(keyLine(after)).toBe(
        "OPS_HUB_PROMOTION_REPOS=deanjstone/homelab,deanjstone/atto1,deanjstone/skills,deanjstone/ops-hub",
      );
      expect(withoutKey(after)).toBe(withoutKey(before));
      expect(statSync(scratch.envFile).mode & 0o777).toBe(0o600);

      const log = calls(scratch);
      expect(log).toMatch(/git clone git@github\.com:deanjstone\/ops-hub\.git \S*\/repos\/ops-hub/);
      expect(log).toMatch(/systemctl --user restart ops-hub/);
      expect(log).toMatch(/curl [^\n]*127\.0\.0\.1:3790\/healthz/);
      expect(log.indexOf("restart")).toBeLessThan(log.indexOf("healthz"));
      expect(output(result)).not.toContain(SECRET);
      expect(output(result)).not.toContain("owner@example.invalid");
    });

    it("detaches the clone at origin/deploy once that branch exists", () => {
      const scratch = makeScratch(defaultEnv());
      const result = run(scratch, [], { FAKE_DEPLOY_STATUS: "0" });
      expect(result.status).toBe(0);
      expect(calls(scratch)).toMatch(/-C \S*\/repos\/ops-hub switch --detach origin\/deploy/);
    });

    it("leaves the clone on its default branch while deploy does not exist", () => {
      const scratch = makeScratch(defaultEnv());
      const result = run(scratch, []);
      expect(result.status).toBe(0);
      expect(calls(scratch)).not.toMatch(/switch/);
      expect(result.stdout).toMatch(/no deploy branch yet/i);
    });

    it("is idempotent: a second run changes neither the .env nor the clone", () => {
      const scratch = makeScratch(defaultEnv());
      expect(run(scratch, []).status).toBe(0);
      const afterFirst = readFileSync(scratch.envFile, "utf8");
      writeFileSync(scratch.log, "");
      const second = run(scratch, []);
      expect(second.status).toBe(0);
      expect(readFileSync(scratch.envFile, "utf8")).toBe(afterFirst);
      expect(afterFirst.match(/deanjstone\/ops-hub/g)).toHaveLength(1);
      expect(calls(scratch)).not.toMatch(/clone/);
      expect(second.stdout).toMatch(/already/i);
      expect(calls(scratch)).toMatch(/restart/);
      expect(calls(scratch)).toMatch(/healthz/);
    });

    it("keeps a space-separated list space-separated", () => {
      const scratch = makeScratch(defaultEnv("deanjstone/homelab deanjstone/atto1"));
      expect(run(scratch, []).status).toBe(0);
      expect(keyLine(readFileSync(scratch.envFile, "utf8"))).toBe(
        "OPS_HUB_PROMOTION_REPOS=deanjstone/homelab deanjstone/atto1 deanjstone/ops-hub",
      );
    });

    it("writes just the repo when the key is empty", () => {
      const scratch = makeScratch(defaultEnv(""));
      expect(run(scratch, []).status).toBe(0);
      expect(keyLine(readFileSync(scratch.envFile, "utf8"))).toBe("OPS_HUB_PROMOTION_REPOS=deanjstone/ops-hub");
    });

    it("reads the port from the .env", () => {
      const scratch = makeScratch(defaultEnv().replace("NOTICE_BOARD_PORT=3790", "NOTICE_BOARD_PORT=4111"));
      expect(run(scratch, []).status).toBe(0);
      expect(calls(scratch)).toMatch(/127\.0\.0\.1:4111\/healthz/);
    });

    it("exits non-zero when /healthz never answers", () => {
      const scratch = makeScratch(defaultEnv());
      const result = run(scratch, [], { FAKE_CURL_STATUS: "7" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/healthz/);
      expect(output(result)).not.toContain(SECRET);
    });
  });

  it("never promotes, pushes, dispatches, deploys or prints a secret", () => {
    expect(code).not.toMatch(/promote\.sh|git push|gh workflow|gh api|deploy\.sh/);
    expect(code).not.toMatch(/set -x|set -o xtrace/);
    expect(code).not.toMatch(/(^|\s)(\.|source)\s+"?\$\{?ENV_FILE/m);
  });
});
