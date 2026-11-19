import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/bws-store-secret.sh stores one secret in Bitwarden Secrets Manager from a hidden
// prompt (argus#21). Every case runs the real script against a stub `bws` that keeps its
// "store" in a JSON file in a throwaway directory: the real Secrets Manager is never called.

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "bws-store-secret.sh");

const SECRET = "sUp3r-s3cret-VALUE-9f8e7d";
const PROJECT = "stub-project-one";
const OTHER_PROJECT = "stub-project-two";

// A stand-in for `bws` 2.x: `secret list -o json`, `secret create KEY VALUE PROJECT [--note N]`
// and `secret edit ID --value V [--note N]`, over $STUB_STORE. Every call is logged to $STUB_LOG
// (the log is the one place the value may appear, standing for the process's own arguments).
const stubBws = `#!/usr/bin/env bash
set -euo pipefail
echo "bws $*" >> "$STUB_LOG"
[ "$1" = secret ] || exit 64
sub="$2"
shift 2
note=""
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --note) note="$2"; shift 2 ;;
    --value) value="$2"; shift 2 ;;
    -o) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
case "$sub" in
  list)
    cat "$STUB_STORE"
    ;;
  create)
    [ -z "\${STUB_FAIL_WRITE:-}" ] || { echo "stub: write refused" >&2; exit 1; }
    tmp="$STUB_STORE.tmp"
    jq --arg k "\${args[0]}" --arg v "\${args[1]}" --arg p "\${args[2]}" --arg n "$note" \\
      '. + [{id: ("new-" + $k), key: $k, value: $v, projectId: $p, note: $n}]' "$STUB_STORE" > "$tmp"
    mv "$tmp" "$STUB_STORE"
    echo '{"id":"stub"}'
    ;;
  edit)
    [ -z "\${STUB_FAIL_WRITE:-}" ] || { echo "stub: write refused" >&2; exit 1; }
    tmp="$STUB_STORE.tmp"
    jq --arg id "\${args[0]}" --arg v "$value" --arg n "$note" --argjson hasNote "$([ -n "$note" ] && echo true || echo false)" \\
      'map(if .id == $id then .value = $v | (if $hasNote then .note = $n else . end) else . end)' "$STUB_STORE" > "$tmp"
    mv "$tmp" "$STUB_STORE"
    echo '{"id":"stub"}'
    ;;
  *) exit 64 ;;
esac
`;

type Row = { id: string; key: string; value: string; projectId: string; note?: string };

let dir: string;
let home: string;
let storeFile: string;
let logFile: string;

const writeStore = (rows: Row[]) => writeFileSync(storeFile, JSON.stringify(rows));
const readStore = (): Row[] => JSON.parse(readFileSync(storeFile, "utf8"));
const readLog = () => readFileSync(logFile, "utf8");

const baseEnv = (): Record<string, string> => ({
  BWS_SECRET_KEY: "example-token",
  BWS_PROJECT_ID: PROJECT,
});

function run(args: string[], env: Record<string, string | undefined>, input = `${SECRET}\n`) {
  const merged: Record<string, string> = {
    HOME: home,
    USER: "tester",
    PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    STUB_STORE: storeFile,
    STUB_LOG: logFile,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) merged[name] = value;
  }
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env: merged, input });
}

const output = (result: ReturnType<typeof run>) => `${result.stdout}\n${result.stderr}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bws-store-secret-"));
  home = join(dir, "home");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(home, { recursive: true });
  storeFile = join(dir, "store.json");
  logFile = join(dir, "bws.log");
  writeFileSync(logFile, "");
  writeStore([]);
  const stub = join(dir, "bin", "bws");
  writeFileSync(stub, stubBws);
  chmodSync(stub, 0o755);
  writeFileSync(join(home, ".bws_token"), "BWS_ACCESS_TOKEN=stub-access-token\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scripts/bws-store-secret.sh", () => {
  it("parses as bash", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it("creates the secret in BWS_PROJECT_ID and confirms it", () => {
    const result = run([], baseEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Stored: example-token");
    expect(readStore()).toEqual([
      expect.objectContaining({ key: "example-token", value: SECRET, projectId: PROJECT }),
    ]);
  });

  it("creates the secret in the project of BWS_SIBLING_KEY", () => {
    writeStore([{ id: "s1", key: "sibling-token", value: "x", projectId: OTHER_PROJECT }]);
    const result = run([], { BWS_SECRET_KEY: "example-token", BWS_SIBLING_KEY: "sibling-token" });
    expect(result.status).toBe(0);
    expect(readStore().find((row) => row.key === "example-token")?.projectId).toBe(OTHER_PROJECT);
  });

  it("exits 1 when BWS_SIBLING_KEY names no existing secret, and writes nothing", () => {
    const result = run([], { BWS_SECRET_KEY: "example-token", BWS_SIBLING_KEY: "no-such-key" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no-such-key");
    expect(readLog()).not.toMatch(/secret (create|edit)/);
  });

  it("replaces the value of an existing key with `secret edit`, never creating a second one", () => {
    writeStore([{ id: "s1", key: "example-token", value: "old-value", projectId: PROJECT, note: "old note" }]);
    const result = run([], baseEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("replacing");
    const rows = readStore();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "s1", value: SECRET });
    expect(readLog()).toContain("secret edit s1");
    expect(readLog()).not.toContain("secret create");
  });

  it("leaves the existing note alone when no note is given", () => {
    writeStore([{ id: "s1", key: "example-token", value: "old-value", projectId: PROJECT, note: "old note" }]);
    run([], baseEnv());
    expect(readStore()[0]?.note).toBe("old note");
  });

  it("matches an existing key only inside the project it stores into", () => {
    writeStore([{ id: "s9", key: "example-token", value: "elsewhere", projectId: OTHER_PROJECT }]);
    const result = run([], baseEnv());
    expect(result.status).toBe(0);
    const rows = readStore();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "s9")?.value).toBe("elsewhere");
  });

  it.each([
    ["BWS_SECRET_KEY", { BWS_PROJECT_ID: PROJECT }],
    ["BWS_PROJECT_ID", { BWS_SECRET_KEY: "example-token" }],
  ])("refuses to run with %s missing, before prompting or calling bws", (name, env) => {
    const result = run([], env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(name);
    expect(readLog()).toBe("");
  });

  it("refuses a malformed SECRET_EXPIRES", () => {
    const result = run([], { ...baseEnv(), SECRET_EXPIRES: "next tuesday" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("SECRET_EXPIRES");
    expect(readLog()).toBe("");
  });

  it("exits 1 and stores nothing for an empty paste", () => {
    const result = run([], baseEnv(), "\n");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Nothing pasted, nothing stored.");
    expect(readLog()).not.toMatch(/secret (create|edit)/);
    expect(readStore()).toEqual([]);
  });

  it("warns on a wrong SECRET_PREFIX but still stores, and does not echo the value", () => {
    const result = run([], { ...baseEnv(), SECRET_PREFIX: "github_pat_" });
    expect(result.status).toBe(0);
    expect(output(result)).toContain("does not start with github_pat_");
    expect(readStore()).toHaveLength(1);
  });

  it("says the prefix is fine when it matches", () => {
    const result = run([], { ...baseEnv(), SECRET_PREFIX: "github_pat_" }, "github_pat_abc123\n");
    expect(result.status).toBe(0);
    expect(output(result)).toContain("prefix OK");
    expect(output(result)).not.toContain("does not start with");
  });

  it("never prints the value to stdout or stderr: success, replace, empty, wrong prefix, failed write, dry run", () => {
    const outputs: string[] = [];
    outputs.push(output(run([], baseEnv())));
    outputs.push(output(run([], baseEnv())));
    outputs.push(output(run([], { ...baseEnv(), SECRET_PREFIX: "github_pat_" })));
    outputs.push(output(run([], { ...baseEnv(), STUB_FAIL_WRITE: "1" })));
    outputs.push(output(run(["--dry-run"], baseEnv())));
    for (const text of outputs) expect(text).not.toContain(SECRET);
  });

  it("builds the note from SECRET_NOTE and SECRET_EXPIRES, ending `Expires <date>`", () => {
    run([], { ...baseEnv(), SECRET_NOTE: "deanjstone-hl JIT token", SECRET_EXPIRES: "2027-10-31" });
    expect(readStore()[0]?.note).toBe("deanjstone-hl JIT token Expires 2027-10-31");
  });

  it("makes the note `Expires <date>` when only SECRET_EXPIRES is set", () => {
    run([], { ...baseEnv(), SECRET_EXPIRES: "2027-10-31" });
    expect(readStore()[0]?.note).toBe("Expires 2027-10-31");
  });

  it("stores SECRET_NOTE as given when there is no expiry", () => {
    run([], { ...baseEnv(), SECRET_NOTE: "just a note" });
    expect(readStore()[0]?.note).toBe("just a note");
  });

  it("defaults SECRET_EXPIRES to 12 months out for a github_pat_ token", () => {
    const expected = spawnSync("date", ["-d", "+12 months", "+%F"], { encoding: "utf8" }).stdout.trim();
    run([], { ...baseEnv(), SECRET_PREFIX: "github_pat_", SECRET_NOTE: "fine-grained" }, "github_pat_abc123\n");
    expect(readStore()[0]?.note).toBe(`fine-grained Expires ${expected}`);
  });

  it("lets an explicit SECRET_EXPIRES override the github_pat_ default", () => {
    run([], { ...baseEnv(), SECRET_PREFIX: "github_pat_", SECRET_EXPIRES: "2027-01-02" }, "github_pat_abc123\n");
    expect(readStore()[0]?.note).toBe("Expires 2027-01-02");
  });

  it("exits 1 when the key is not visible after the write", () => {
    const result = run([], { ...baseEnv(), STUB_FAIL_WRITE: "1" });
    expect(result.status).toBe(1);
    expect(output(result)).toContain("Store FAILED");
  });

  it("--dry-run says what it would do without prompting, writing or reading a value", () => {
    writeStore([{ id: "s1", key: "example-token", value: "old-value", projectId: PROJECT }]);
    const result = run(["--dry-run"], baseEnv(), "");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("replace");
    expect(readLog()).not.toMatch(/secret (create|edit)/);
    expect(readStore()[0]?.value).toBe("old-value");
  });

  it("--dry-run says create when the key is absent", () => {
    const result = run(["--dry-run"], baseEnv(), "");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("create");
    expect(readStore()).toEqual([]);
  });

  it("--dry-run still refuses a missing required variable", () => {
    expect(run(["--dry-run"], { BWS_PROJECT_ID: PROJECT }).status).toBe(2);
  });

  it("reads the token from BWS_TOKEN_FILE and fails naming the file when it is missing", () => {
    const missing = join(dir, "no-such-token-file");
    const result = run([], { ...baseEnv(), BWS_TOKEN_FILE: missing });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missing);
    expect(readLog()).toBe("");
  });

  it("exits 1 when bws is not on PATH", () => {
    const result = spawnSync("/bin/bash", [script], {
      encoding: "utf8",
      input: `${SECRET}\n`,
      env: { HOME: home, PATH: "/nonexistent", ...baseEnv() },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bws");
  });

  it.each([["--live"], ["--dry-run", "extra"], ["x"]])("exits 2 on arguments %j", (...args) => {
    const result = run(args, baseEnv());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });
});
