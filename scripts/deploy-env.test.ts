import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Deploy-time .env files live outside the deploy copy, at ~/.config/argus/<app>.env
// (argus-config#1267). The worktree-policy hook blocks every write into a ~/repos/* deploy
// copy, so an agent could not create or fix an env file kept at apps/<app>/.env. Expand,
// migrate, contract: a script that reads an env file reads the new path first, falls back to
// the old one with a deprecation warning, and with neither fails naming the new path. A
// script that writes one now writes the new path. Each case runs a copy of the real script
// in a throwaway HOME and repo, with the tools it calls stubbed.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const makeCheckout = join(root, "scripts/test-support/make-deploy-checkout.sh");
const appEnvLib = join(root, "scripts/lib/app-env.sh");

let home: string;
let repo: string;
let stubLog: string;

const newEnv = (app: string) => join(home, ".config/argus", `${app}.env`);
const oldEnv = (app: string) => join(repo, "apps", app, ".env");

async function writeStub(name: string, body: string) {
  const stub = join(home, "bin", name);
  await writeFile(stub, body);
  await chmod(stub, 0o755);
}

// Lay the real deploy.sh out like the repo: <repo>/apps/<app>/deploy.sh, with the shared lib.
async function install(app: string) {
  await mkdir(join(repo, "apps", app), { recursive: true });
  await mkdir(join(repo, "scripts/lib"), { recursive: true });
  await copyFile(join(root, "apps", app, "deploy.sh"), join(repo, "apps", app, "deploy.sh"));
  await copyFile(appEnvLib, join(repo, "scripts/lib/app-env.sh"));
}

async function runDeploy(app: string, extraEnv: Record<string, string> = {}) {
  return execFileAsync("bash", [join(repo, "apps", app, "deploy.sh")], {
    cwd: join(repo, "apps", app),
    env: {
      HOME: home,
      USER: "tester",
      PATH: `${join(home, "bin")}:/usr/bin:/bin`,
      STUB_LOG: stubLog,
      BWS_ACCESS_TOKEN: "test-bws-access-token",
      FAKE_BWS_SECRETS: "[]",
      ...extraEnv,
    },
  });
}

const output = (result: { stdout: string; stderr: string }) => `${result.stdout}${result.stderr}`;
const mode = async (path: string) => (await stat(path)).mode & 0o777;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "deploy-env-"));
  repo = join(home, "repo");
  stubLog = join(home, "stub.log");
  await execFileAsync("bash", [makeCheckout, repo]);
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(stubLog, "");
  await writeStub("bws", '#!/usr/bin/env bash\nprintf \'%s\' "$FAKE_BWS_SECRETS"\n');
  await writeStub("pnpm", '#!/usr/bin/env bash\necho "pnpm $*" >> "$STUB_LOG"\n');
  await writeStub("systemctl", '#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_LOG"\n');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("scripts/lib/app-env.sh", () => {
  const callLib = (snippet: string) =>
    execFileAsync("bash", ["-c", `source "${appEnvLib}"; ${snippet}`], { env: { HOME: home, PATH: "/usr/bin:/bin" } });

  it("names the env file for an app under ~/.config/argus", async () => {
    const { stdout } = await callLib("app_env_path watchtower-collector");
    expect(stdout.trim()).toBe(`${home}/.config/argus/watchtower-collector.env`);
  });

  it("creates the directory 0700", async () => {
    await callLib("app_env_ensure_dir");
    expect(await mode(join(home, ".config/argus"))).toBe(0o700);
  });

  it("resolves to the new file when only it exists, with no warning", async () => {
    await mkdir(join(home, ".config/argus"), { recursive: true });
    await writeFile(newEnv("demo"), "KEY=1\n");
    const result = await callLib('app_env_resolve demo "$HOME/legacy.env"');
    expect(result.stdout.trim()).toBe(newEnv("demo"));
    expect(result.stderr).not.toMatch(/deprecat/i);
  });

  it("resolves to the old file when only it exists, and warns naming both paths", async () => {
    await writeFile(join(home, "legacy.env"), "KEY=1\n");
    const result = await callLib('app_env_resolve demo "$HOME/legacy.env"');
    expect(result.stdout.trim()).toBe(join(home, "legacy.env"));
    expect(result.stderr).toMatch(/deprecat/i);
    expect(result.stderr).toContain(join(home, "legacy.env"));
    expect(result.stderr).toContain(newEnv("demo"));
  });

  it("prefers the new file when both exist, and still warns about the old one", async () => {
    await mkdir(join(home, ".config/argus"), { recursive: true });
    await writeFile(newEnv("demo"), "KEY=new\n");
    await writeFile(join(home, "legacy.env"), "KEY=old\n");
    const result = await callLib('app_env_resolve demo "$HOME/legacy.env"');
    expect(result.stdout.trim()).toBe(newEnv("demo"));
    expect(result.stderr).toMatch(/deprecat/i);
  });

  it("fails naming the new path when neither exists", async () => {
    const result = callLib('app_env_resolve demo "$HOME/legacy.env"');
    await expect(result).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(newEnv("demo")) });
  });
});

// The writers fetch secrets from BWS and write the env file. They write the new path now, so
// an agent can fix one; a leftover old file is named in a deprecation warning.
describe.each(["watchtower-collector", "watchtower-usage-shim"])("%s deploy.sh writes its env file", (app) => {
  const secrets = JSON.stringify([
    { key: "watchtower-usage-shim-token-wsl2", value: "SECRET-VALUE-usage-shim-0123456789" },
    { key: "watchtower-collector-token", value: "SECRET-VALUE-collector-0123456789" },
    ...Object.entries({
      // The private values the collector reads by name (argus#1207): placeholders, never real ones.
      ARGUS_TAILSCALE_IP_HOMELAB: "100.64.0.2",
      ARGUS_TAILSCALE_IP_WSL2: "100.64.0.1",
      ARGUS_CLOUDFLARE_ACCOUNT_ID: "0000000000000000000000000000a001",
      ARGUS_CLOUDFLARE_ZONE_ID: "0000000000000000000000000000a002",
      ARGUS_D1_WATCHTOWER_DATABASE_ID: "00000000-0000-4000-8000-0000000000d1",
    }).map(([name, placeholder]) => ({ key: name, value: placeholder })),
  ]);

  beforeEach(async () => {
    await install(app);
  });

  it("writes ~/.config/argus/<app>.env 0600 in a 0700 directory, and nothing into the deploy copy", async () => {
    await runDeploy(app, { FAKE_BWS_SECRETS: secrets });

    expect(await mode(newEnv(app))).toBe(0o600);
    expect(await mode(join(home, ".config/argus"))).toBe(0o700);
    await expect(stat(oldEnv(app))).rejects.toThrow(/ENOENT/);
  });

  it("never prints a secret value", async () => {
    const result = await runDeploy(app, { FAKE_BWS_SECRETS: secrets });

    expect(output(result)).not.toContain("SECRET-VALUE");
  });

  it("warns about a leftover old file, naming it and the new path, and leaves it alone", async () => {
    await writeFile(oldEnv(app), "OLD=1\n");

    const result = await runDeploy(app, { FAKE_BWS_SECRETS: secrets });

    expect(output(result)).toMatch(/deprecat/i);
    expect(output(result)).toContain(oldEnv(app));
    expect(output(result)).toContain(newEnv(app));
    expect(await readFile(oldEnv(app), "utf8")).toBe("OLD=1\n");
  });

  it("does not warn when there is no old file", async () => {
    const result = await runDeploy(app, { FAKE_BWS_SECRETS: secrets });

    expect(output(result)).not.toMatch(/deprecat/i);
  });
});

describe("units read the new path", () => {
  const read = (path: string) => readFile(join(root, path), "utf8");

  it.each([
    ["apps/loop-state-mcp/systemd/loop-state-mcp.service", "loop-state-mcp"],
    ["apps/watchtower-collector/systemd/watchtower-collector.service", "watchtower-collector"],
  ])("%s loads the old file first, then the new one, so the new one wins", async (unit, app) => {
    const text = await read(unit);
    const legacy = text.indexOf(`EnvironmentFile=-%h/repos/argus/apps/${app}/.env`);
    const current = text.indexOf(`EnvironmentFile=-%h/.config/argus/${app}.env`);
    expect(legacy).toBeGreaterThanOrEqual(0);
    expect(current).toBeGreaterThan(legacy);
  });
});
