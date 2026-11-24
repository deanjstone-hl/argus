import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// scripts/owner-steps/59.sh is run live by the owner (argus#59). These cases run it against stub
// bws and gh programs that keep a small Secrets Manager and Actions state in files and log every
// write, so they prove what it would move, create and delete without touching either service.
// The stub never logs a value; the cases check that no value reaches the output either. The script
// needs jq; a host without it skips the file, and main CI runs it.

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/owner-steps/59.sh");
const workflowDir = join(root, ".github/workflows");
const hasJq = spawnSync("jq", ["--version"]).status === 0;

const SOURCE = "proj-personal";
const ACTIONS = "proj-actions";
const OWNER_TOKEN = "owner-token-VALUE";

// The two workflows read their ids from one `<uuid> > <ENV_NAME>` map each; the script's table must
// cover every id they map, and nothing else is moved.
const WORKFLOWS = ["watchtower-deploy.yml", "watchtower-deploy-worker.yml"];
const mapOf = (file: string) =>
  [...readFileSync(join(workflowDir, file), "utf8").matchAll(/^\s+([0-9a-f-]{36}) > ([A-Z][A-Z0-9_]+)\s*$/gm)].map((m) => ({ id: m[1], name: m[2] }));
const mappedIds = [...new Set(WORKFLOWS.flatMap((file) => mapOf(file).map((entry) => entry.id)))];

// What the owner's Secrets Manager holds before the run: the key each id has today, and the
// key the script gives it in `actions`. `host` is the key a host reads from personal-machine-secrets.
const TABLE = [
  { id: "daebfc00-1ad4-425e-8c0f-b504014123e0", old: "ARGUS_CLOUDFLARE_API_TOKEN", next: "ARGUS_CF_API_TOKEN", host: "" },
  { id: "5a91a3c7-4bca-464b-81a5-b50401408e70", old: "ARGUS_CLOUDFLARE_D1_TOKEN", next: "ARGUS_CF_D1_TOKEN", host: "" },
  { id: "a4257c90-ae72-4f91-9f75-b50401408c32", old: "ARGUS_VITE_SUPABASE_URL", next: "ARGUS_SUPABASE_URL", host: "" },
  { id: "a25daf63-934e-4bf7-9d4f-b50401408d71", old: "ARGUS_VITE_SUPABASE_ANON_KEY", next: "ARGUS_SUPABASE_ANON_KEY", host: "" },
  { id: "a7767558-b39c-488f-9a1f-b505006359fe", old: "ARGUS_CLOUDFLARE_ACCOUNT_ID", next: "ARGUS_CF_ACCOUNT_ID", host: "ARGUS_CLOUDFLARE_ACCOUNT_ID" },
  { id: "489cf0ba-dad5-4e70-9f3a-b50500635b92", old: "ARGUS_D1_WATCHTOWER_DATABASE_ID", next: "ARGUS_WATCHTOWER_D1_DATABASE_ID", host: "ARGUS_WATCHTOWER_D1_DATABASE_ID" },
] as const;
const withHost = TABLE.filter((row) => row.host);
const valueOf = (row: { next: string }) => `value-of-${row.next}-VALUE`;
const secretValues = TABLE.map(valueOf);
const OLD_ACTIONS_SECRETS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_D1_TOKEN", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL", "WATCHTOWER_D1_DATABASE_ID"];

// A stateful bws: `secret list` serves list.json; edit and create change it and log the key and
// project, never a value. A project list names the two projects.
const bwsStub = [
  "#!/bin/bash",
  '[ -n "${BWS_ACCESS_TOKEN:-}" ] || { echo "Missing access token" >&2; exit 1; }',
  'sub="$1 $2"; shift 2',
  'list="$STUB_DIR/list.json"',
  'case "$sub" in',
  '  "secret list") cat "$list" ;;',
  '  "project list") cat "$STUB_DIR/projects.json" ;;',
  '  "secret edit")',
  '    id=""; key=""; project=""',
  '    while [ $# -gt 0 ]; do case "$1" in --key) key=$2; shift 2 ;; --project-id) project=$2; shift 2 ;; -o) shift 2 ;; *) id="$1"; shift ;; esac; done',
  '    [ -z "${STUB_BWS_FAIL:-}" ] || { echo "bws: simulated failure" >&2; exit 1; }',
  '    echo "bws edit $id key=${key:--} project=${project:--}" >> "$STUB_DIR/calls.log"',
  '    jq -c --arg i "$id" --arg k "$key" --arg p "$project" \'map(if .id == $i then (if $k != "" then .key = $k else . end) | (if $p != "" then .projectId = $p else . end) else . end)\' "$list" > "$list.tmp" && mv "$list.tmp" "$list" ;;',
  '  "secret create")',
  '    key=""; value=""; project=""; n=0',
  '    while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; --note) shift 2 ;; *) n=$((n+1)); case $n in 1) key=$1 ;; 2) value=$1 ;; 3) project=$1 ;; esac; shift ;; esac; done',
  '    [ -z "${STUB_BWS_FAIL:-}" ] || { echo "bws: simulated failure" >&2; exit 1; }',
  '    echo "bws create key=$key project=$project" >> "$STUB_DIR/calls.log"',
  '    jq -c --arg k "$key" --arg v "$value" --arg p "$project" \'. + [{id: ("new-" + $k), key: $k, value: $v, projectId: $p}]\' "$list" > "$list.tmp" && mv "$list.tmp" "$list"',
  '    echo \'{"id":"new"}\' ;;',
  '  *) echo "bws stub: unexpected $sub" >&2; exit 9 ;;',
  "esac",
].join("\n");

// A gh that serves the repository's Actions secrets, the latest Deploy runs and the workflow text at
// a SHA, and deletes a secret from the list.
const ghStub = [
  "#!/bin/bash",
  'echo "gh $*" >> "$STUB_DIR/gh.log"',
  'case "$1 $2" in',
  '  "run list")',
  '    wf=""; while [ $# -gt 0 ]; do case "$1" in --workflow) wf=$2; shift 2 ;; *) shift ;; esac; done',
  '    cat "$STUB_DIR/run_list.$wf.json" ;;',
  '  "secret list") cat "$STUB_DIR/actions_secrets.txt" ;;',
  '  "secret delete")',
  '    name="$3"; echo "gh delete $name" >> "$STUB_DIR/calls.log"',
  '    grep -vx "$name" "$STUB_DIR/actions_secrets.txt" > "$STUB_DIR/actions_secrets.tmp"; mv "$STUB_DIR/actions_secrets.tmp" "$STUB_DIR/actions_secrets.txt" ;;',
  '  "api "*) path="${@: -1}"; wf=${path##*/workflows/}; wf=${wf%%\\?*}; cat "$STUB_DIR/at_sha.$wf" ;;',
  '  *) echo "gh stub: unexpected $*" >&2; exit 9 ;;',
  "esac",
].join("\n");

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, body: string | object, mode?: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" ? `${body}\n` : `${JSON.stringify(body)}\n`);
  if (mode) chmodSync(path, mode);
}

type Place = "before" | "after";
type State = {
  // Per id: still under its old key in the source project ("before"), or moved and renamed ("after").
  place?: Place | Partial<Record<string, Place>>;
  // Which host copies exist already.
  hostCopies?: "all" | "none" | "stale";
  missing?: string[];
};

const listFor = ({ place = "before", hostCopies = "none", missing = [] }: State) => {
  const items: { id: string; key: string; value: string; projectId: string }[] = [
    { id: "id-other", key: "CLOUDFLARE-TOKEN-ADMIN", value: OWNER_TOKEN, projectId: SOURCE },
  ];
  for (const row of TABLE) {
    if (missing.includes(row.id)) continue;
    const where = typeof place === "string" ? place : (place[row.id] ?? "before");
    items.push(where === "before" ? { id: row.id, key: row.old, value: valueOf(row), projectId: SOURCE } : { id: row.id, key: row.next, value: valueOf(row), projectId: ACTIONS });
    if (row.host && where === "after" && hostCopies !== "none") {
      items.push({ id: `copy-${row.host}`, key: row.host, value: hostCopies === "stale" ? "an-older-value-VALUE" : valueOf(row), projectId: SOURCE });
    }
  }
  return items;
};

function world(state: State = {}, options: { secrets?: string[]; red?: string; oldWorkflow?: string; tokenSet?: boolean } = {}) {
  const stub = mkdtempSync(join(tmpdir(), "argus-59-"));
  scratch.push(stub);
  const home = join(stub, "home");
  write(join(stub, "bin/bws"), bwsStub, 0o755);
  write(join(stub, "bin/gh"), ghStub, 0o755);
  write(join(home, ".bws_token"), `BWS_ACCESS_TOKEN=${OWNER_TOKEN}`);
  write(join(stub, "projects.json"), [
    { id: SOURCE, name: "personal-machine-secrets" },
    { id: ACTIONS, name: "actions" },
  ]);
  write(join(stub, "list.json"), listFor(state));
  const secrets = options.secrets ?? [...OLD_ACTIONS_SECRETS, ...(options.tokenSet === false ? [] : ["BWS_ACCESS_TOKEN"])];
  write(join(stub, "actions_secrets.txt"), secrets.join("\n"));
  for (const file of WORKFLOWS) {
    const red = options.red === file;
    write(join(stub, `run_list.${file}.json`), [{ conclusion: red ? "failure" : "success", headSha: "abc123", databaseId: 42 }]);
    write(join(stub, `at_sha.${file}`), options.oldWorkflow === file ? readFileSync(join(workflowDir, file), "utf8").replace(/uses: bitwarden\/sm-action@\S+/, "uses: actions/checkout@v4") : readFileSync(join(workflowDir, file), "utf8"));
  }
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { PATH: `${join(stub, "bin")}:${process.env.PATH ?? ""}`, HOME: home, STUB_DIR: stub, ...env },
    });
    const read = (file: string) => (existsSync(join(stub, file)) ? readFileSync(join(stub, file), "utf8") : "");
    return {
      ...result,
      all: `${result.stdout}${result.stderr}`,
      calls: read("calls.log").split("\n").filter(Boolean),
      remaining: read("actions_secrets.txt").split("\n").filter(Boolean),
      list: JSON.parse(read("list.json")) as { id: string; key: string; value: string; projectId: string }[],
    };
  };
  return { run, stub };
}

const noSecretPrinted = (all: string) => {
  for (const value of [...secretValues, OWNER_TOKEN]) expect(all).not.toContain(value);
};

describe.skipIf(!hasJq)("scripts/owner-steps/59.sh", () => {
  it("covers every secret id the two workflows map, and the table in this test matches", () => {
    expect(mappedIds.sort()).toEqual(TABLE.map((row) => row.id).sort());
    expect(readdirSync(workflowDir)).toEqual(expect.arrayContaining(WORKFLOWS));
  });

  it("refuses an unknown argument", () => {
    expect(world().run(["--now"]).status).toBe(2);
    expect(world().run(["--delete-actions-secrets", "--dry-run", "--extra"]).status).toBe(2);
  });

  describe("moving the keys to the actions project", () => {
    it("stops, changing nothing, when the Secrets Manager token file is missing", () => {
      const { run, stub } = world();
      rmSync(join(stub, "home/.bws_token"));
      const result = run(["--dry-run"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED: .*\.bws_token exists/);
      expect(result.stderr).toMatch(/nothing was changed/);
    });

    it("stops before any change when an id a workflow maps has no secret behind it", () => {
      const result = world({ missing: [TABLE[0].id] }).run([]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`pre-flight FAILED: .*${TABLE[0].old}`));
      expect(result.calls).toEqual([]);
    });

    it("stops before any change when BWS_ACCESS_TOKEN is not set on the repository", () => {
      const result = world({}, { tokenSet: false }).run([]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED: .*BWS_ACCESS_TOKEN/);
      expect(result.calls).toEqual([]);
    });

    it("stops when a workflow maps an id the script does not know", () => {
      const { run, stub } = world();
      const extra = readFileSync(join(stub, "at_sha.watchtower-deploy.yml"), "utf8");
      writeFileSync(join(stub, "alt-workflow.yml"), `${extra}\n            11111111-2222-4333-8444-555555555555 > EXTRA\n`);
      const result = run(["--dry-run"], { ARGUS_WORKFLOWS: join(stub, "alt-workflow.yml") });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED: .*11111111-2222-4333-8444-555555555555/);
    });

    it("--dry-run prints every move and host copy, reads state, and writes nothing", () => {
      const result = world().run(["--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      for (const row of TABLE) {
        expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] .*move ${row.old} \\(${row.id}\\) .*to actions as ${row.next}`));
      }
      for (const row of withHost) expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] .*create ${row.host} in personal-machine-secrets`));
      noSecretPrinted(result.all);
    });

    it("moves and renames each id into actions, creates the two host copies, and prints no value", () => {
      const result = world().run([]);
      expect(result.stderr).not.toMatch(/FAILED|error/i);
      expect(result.status).toBe(0);
      expect(result.calls.filter((call) => call.startsWith("bws edit")).sort()).toEqual(
        TABLE.map((row) => `bws edit ${row.id} key=${row.next} project=${ACTIONS}`).sort(),
      );
      expect(result.calls.filter((call) => call.startsWith("bws create")).sort()).toEqual(withHost.map((row) => `bws create key=${row.host} project=${SOURCE}`).sort());
      // The state the stub now holds is what the workflows and the hosts read.
      for (const row of TABLE) {
        expect(result.list.find((item) => item.id === row.id)).toMatchObject({ key: row.next, projectId: ACTIONS, value: valueOf(row) });
      }
      for (const row of withHost) {
        expect(result.list.find((item) => item.key === row.host && item.projectId === SOURCE)).toMatchObject({ value: valueOf(row) });
      }
      expect(result.stdout).toMatch(/verify ok: the 6 workflow ids are in actions, each under its own key/);
      expect(result.stdout).toMatch(/verify ok: .* copy .* same value/);
      noSecretPrinted(result.all);
    });

    it("creates the host copy only after the move, so a failed move leaves the original where it was", () => {
      const result = world().run([], { STUB_BWS_FAIL: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/error: could not move/);
      expect(result.calls.filter((call) => call.startsWith("bws create"))).toEqual([]);
      noSecretPrinted(result.all);
    });

    it("fails the verify when a host copy that already exists holds another value than its original", () => {
      const result = world({ place: "after", hostCopies: "stale" }).run([]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/verify FAILED: the host copy ARGUS_CLOUDFLARE_ACCOUNT_ID in personal-machine-secrets holds the same value/);
      expect(result.all).not.toContain("an-older-value-VALUE");
    });

    it("is read-only when everything is already in place", () => {
      const result = world({ place: "after", hostCopies: "all" }).run([]);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toMatch(/nothing to change/);
    });

    it("creates only the missing host copies when the moves are done", () => {
      const result = world({ place: "after", hostCopies: "none" }).run([]);
      expect(result.status).toBe(0);
      expect(result.calls.sort()).toEqual(withHost.map((row) => `bws create key=${row.host} project=${SOURCE}`).sort());
    });

    it("moves only the ids not yet in actions", () => {
      const rest = Object.fromEntries(TABLE.slice(1).map((row) => [row.id, "after" as Place]));
      const result = world({ place: rest, hostCopies: "all" }).run([]);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([`bws edit ${TABLE[0].id} key=${TABLE[0].next} project=${ACTIONS}`]);
    });
  });

  describe("deleting the Actions secrets the green deploy no longer reads", () => {
    it("refuses, deleting nothing, when the latest Deploy run of a workflow is red", () => {
      const result = world({ place: "after", hostCopies: "all" }, { red: "watchtower-deploy-worker.yml" }).run(["--delete-actions-secrets"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED: .*watchtower-deploy-worker\.yml.*succeeded/);
      expect(result.calls).toEqual([]);
    });

    it("refuses when a green run's workflow is from before sm-action", () => {
      const result = world({ place: "after", hostCopies: "all" }, { oldWorkflow: "watchtower-deploy.yml" }).run(["--delete-actions-secrets"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED: .*watchtower-deploy\.yml.*sm-action/);
      expect(result.calls).toEqual([]);
    });

    it("refuses when BWS_ACCESS_TOKEN is not set, since the green deploy could not have used it", () => {
      const result = world({}, { tokenSet: false }).run(["--delete-actions-secrets"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED: .*BWS_ACCESS_TOKEN/);
    });

    it("--dry-run lists the six deletions and deletes nothing", () => {
      const result = world().run(["--delete-actions-secrets", "--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      for (const name of OLD_ACTIONS_SECRETS) expect(result.stdout).toContain(`[dry-run] delete Actions secret ${name}`);
    });

    it("deletes the six old secrets, keeps BWS_ACCESS_TOKEN, and verifies", () => {
      const result = world().run(["--delete-actions-secrets"]);
      expect(result.status).toBe(0);
      expect(result.calls.sort()).toEqual(OLD_ACTIONS_SECRETS.map((name) => `gh delete ${name}`).sort());
      expect(result.remaining).toEqual(["BWS_ACCESS_TOKEN"]);
      expect(result.stdout).toMatch(/verify ok: BWS_ACCESS_TOKEN is still set/);
    });

    it("keeps a secret a green workflow still reads", () => {
      const { run, stub } = world();
      const text = readFileSync(join(stub, "at_sha.watchtower-deploy.yml"), "utf8");
      writeFileSync(join(stub, "at_sha.watchtower-deploy.yml"), `${text}\n          still: \${{ secrets.VITE_SUPABASE_URL }}\n`);
      const result = run(["--delete-actions-secrets"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/keep VITE_SUPABASE_URL: .* still reads it/);
      expect(result.remaining.sort()).toEqual(["BWS_ACCESS_TOKEN", "VITE_SUPABASE_URL"]);
    });

    it("says so and changes nothing when the old secrets are already gone", () => {
      const result = world({}, { secrets: ["BWS_ACCESS_TOKEN"] }).run(["--delete-actions-secrets"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/nothing to delete/);
      expect(result.calls).toEqual([]);
    });
  });
});
