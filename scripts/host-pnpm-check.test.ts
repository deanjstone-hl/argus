import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../.github/actions/host-pnpm/check.sh", import.meta.url));
const pin = "pnpm@12.13.0";

// A corepack shim runs whatever version the nearest packageManager pin names,
// unless COREPACK_ENABLE_PROJECT_SPEC=0 tells it to ignore the pin.
const corepackShim = `#!/usr/bin/env bash
if [[ "\${COREPACK_ENABLE_PROJECT_SPEC:-1}" == 0 ]]; then echo 11.10.0; exit 0; fi
node -p "require('./package.json').packageManager.slice('pnpm@'.length)"
`;

interface Fixture {
  pnpm: { kind: "standalone"; version: string } | { kind: "corepack" };
  rootPin?: string;
  nestedPin?: string;
  // The repo has no root package.json, as in context, which runs the action in a
  // nested checkout of argus.
  noRootPackage?: boolean;
  env?: Record<string, string>;
}

function run(fixture: Fixture): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), "host-pnpm-"));
  const workspace = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(workspace, "apps", "nested"), { recursive: true });
  mkdirSync(bin);
  const writePin = (dir: string, value: string | undefined) =>
    writeFileSync(join(dir, "package.json"), JSON.stringify(value ? { packageManager: value } : {}));
  if (!fixture.noRootPackage) writePin(workspace, fixture.rootPin ?? pin);
  writePin(join(workspace, "apps", "nested"), fixture.nestedPin ?? fixture.rootPin ?? pin);

  if (fixture.pnpm.kind === "standalone") {
    writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash\necho ${fixture.pnpm.version}\n`);
    chmodSync(join(bin, "pnpm"), 0o755);
  } else {
    const dist = join(root, "lib", "node_modules", "corepack", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "pnpm.js"), corepackShim);
    chmodSync(join(dist, "pnpm.js"), 0o755);
    symlinkSync(join(dist, "pnpm.js"), join(bin, "pnpm"));
  }

  const cwd = fixture.nestedPin || fixture.noRootPackage ? join(workspace, "apps", "nested") : workspace;
  const result = spawnSync("bash", [script], {
    cwd,
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GITHUB_WORKSPACE: workspace,
      GITHUB_PATH: join(root, "github-path"),
      ...fixture.env,
    },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("host-pnpm check", () => {
  it("passes a standalone pnpm at the pinned version", () => {
    const { status, output } = run({ pnpm: { kind: "standalone", version: "12.13.0" } });
    expect(output).toContain("pnpm --version: 12.13.0 (standalone at");
    expect(status).toBe(0);
  });

  it("fails a standalone pnpm that has drifted from the pin", () => {
    const { status, output } = run({ pnpm: { kind: "standalone", version: "11.0.0" } });
    expect(output).toContain("::error::pnpm 11.0.0 (standalone) does not match the packageManager pin 12.13.0");
    expect(status).toBe(1);
  });

  it("passes a corepack shim running the pinned version", () => {
    const { status, output } = run({ pnpm: { kind: "corepack" } });
    expect(output).toContain("pnpm --version: 12.13.0 (corepack shim at");
    expect(status).toBe(0);
  });

  it("fails a corepack shim told to ignore the pin", () => {
    const { status, output } = run({
      pnpm: { kind: "corepack" },
      env: { COREPACK_ENABLE_PROJECT_SPEC: "0" },
    });
    expect(output).toContain("::error::COREPACK_ENABLE_PROJECT_SPEC=0");
    expect(status).toBe(1);
  });

  it("fails a nested pin that has drifted from the root pin", () => {
    const { status, output } = run({ pnpm: { kind: "corepack" }, nestedPin: "pnpm@11.9.0" });
    expect(output).toContain("pins pnpm@11.9.0, but the root package.json pins pnpm@12.13.0");
    expect(status).toBe(1);
  });

  it("skips the root-pin check when the repo has no root package.json", () => {
    const { status, output } = run({ pnpm: { kind: "corepack" }, noRootPackage: true });
    expect(output).toContain("pnpm --version: 12.13.0 (corepack shim at");
    expect(output).not.toContain("root pin");
    expect(status).toBe(0);
  });

  it("fails when there is no pnpm pin", () => {
    const { status, output } = run({ pnpm: { kind: "corepack" }, rootPin: "npm@10.0.0" });
    expect(output).toContain("::error::package.json has no pnpm@<version> packageManager pin");
    expect(status).toBe(1);
  });
});
