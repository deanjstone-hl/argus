import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/owner-steps/1126.sh is the live teardown of the retired vault-agent relay
// (argus/1126, relay removed from the tree by argus/1125): the Worker, its Durable Object, the
// custom domain with its DNS record and the MCP_AUTH_TOKEN secret, approved as one command.
// The script runs here against a fake `cf`, `curl` and `sleep` on PATH whose state lives in
// files, so nothing live is touched and the real `cf` is never on PATH.

const script = fileURLToPath(new URL("owner-steps/1126.sh", import.meta.url));
const code = readFileSync(script, "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

const WORKER = "argus-vault-agent-relay";
const HOST = "vault.myargus.cc";
const SECRET_NAME = "MCP_AUTH_TOKEN";
const SECRET_VALUE = "s3cret-sentinel-value";

const FAKES: Record<string, string> = {
  sleep: "exit 0",
  curl: `echo "curl $*" >> "$FAKE_LOG"
if [ -n "\${FAKE_HEALTH_STICKS:-}" ] || { [ -e "$FAKE_STATE/worker" ] && [ -e "$FAKE_STATE/dns" ]; }; then printf '401'; exit 0; fi
printf '000'
exit 6`,
  cf: `echo "cf $*" >> "$FAKE_LOG"
state="$FAKE_STATE"
case "$1 $2" in
  "auth whoami")
    if [ -n "\${FAKE_UNAUTH:-}" ]; then echo '{"authenticated":false}'; else echo '{"authenticated":true}'; fi ;;
  "workers list")
    out='{"name":"argus-memory-mcp","references":{"workers":[],"domains":[{"hostname":"memory.myargus.cc"}],"durable_objects":[]}}'
    if [ -e "$state/worker" ]; then
      wrefs='[]'; [ -z "\${FAKE_WORKER_REF:-}" ] || wrefs='["other-worker"]'
      extra=''; [ -z "\${FAKE_OTHER_DOMAIN:-}" ] || extra=',{"hostname":"elsewhere.myargus.cc"}'
      out="$out,{\\"name\\":\\"argus-vault-agent-relay\\",\\"references\\":{\\"workers\\":$wrefs,\\"domains\\":[{\\"hostname\\":\\"vault.myargus.cc\\"}$extra],\\"durable_objects\\":[{\\"namespace_name\\":\\"argus-vault-agent-relay_VaultRelay\\"}]}}"
    fi
    echo "[$out]" ;;
  "workers delete")
    [ -z "\${FAKE_DELETE_FAILS:-}" ] || { echo "delete refused" >&2; exit 1; }
    rm -f "$state/worker" "$state/secret"
    [ -n "\${FAKE_DNS_SURVIVES:-}" ] || rm -f "$state/dns" ;;
  "workers secrets")
    case "$3" in
      list)
        if [ -e "$state/worker" ] && [ -e "$state/secret" ]; then echo '[{"name":"MCP_AUTH_TOKEN","type":"secret_text"}]'; else echo '[]'; fi ;;
      delete) rm -f "$state/secret" ;;
    esac ;;
  "dns records")
    case "$3" in
      list)
        if [ -e "$state/dns" ]; then echo '[{"id":"rec-1","type":"AAAA","name":"vault.myargus.cc"}]'; else echo '[]'; fi ;;
      delete)
        [ -z "\${FAKE_DNS_DELETE_FAILS:-}" ] || { echo "record is managed" >&2; exit 1; }
        rm -f "$state/dns" ;;
    esac ;;
esac
exit 0`,
};

type Scratch = { root: string; bin: string; log: string; state: string };

const makeScratch = (present: { worker?: boolean; dns?: boolean; secret?: boolean } = {}): Scratch => {
  const { worker = true, dns = true, secret = true } = present;
  const root = mkdtempSync(join(tmpdir(), "owner-steps-1126-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(bin);
  mkdirSync(state);
  for (const [name, body] of Object.entries(FAKES)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  if (worker) writeFileSync(join(state, "worker"), "");
  if (dns) writeFileSync(join(state, "dns"), "");
  if (secret) writeFileSync(join(state, "secret"), SECRET_VALUE);
  return { root, bin, log: join(root, "calls.log"), state };
};

const run = (scratch: Scratch, args: string[], extra: Record<string, string> = {}, path = scratch.bin) => {
  writeFileSync(scratch.log, "", { flag: "a" });
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${path}:/usr/bin:/bin`,
      HOME: scratch.root,
      FAKE_LOG: scratch.log,
      FAKE_STATE: scratch.state,
      ...extra,
    },
  });
};

const calls = (scratch: Scratch) => (existsSync(scratch.log) ? readFileSync(scratch.log, "utf8") : "");
const output = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`;
const has = (scratch: Scratch, name: string) => existsSync(join(scratch.state, name));
const mutating = /^cf (workers delete|workers secrets delete|dns records delete)/m;

describe("owner-steps/1126.sh", () => {
  it("is executable", () => {
    expect(() => accessSync(script, constants.X_OK)).not.toThrow();
  });

  it.each([["--live"], ["--dry-run", "extra"], ["x"]])("exits 2 on arguments %j", (...args) => {
    const scratch = makeScratch();
    const result = run(scratch, args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage/);
    expect(calls(scratch)).toBe("");
  });

  describe("--dry-run", () => {
    it("prints each command and the verify checks, and changes nothing", () => {
      const scratch = makeScratch();
      const result = run(scratch, ["--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] cf workers delete ${WORKER} `));
      expect(result.stdout).toMatch(/Durable Object[^\n]*argus-vault-agent-relay_VaultRelay/);
      expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] cf dns records delete[^\\n]*${HOST}`));
      expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] cf workers secrets delete ${SECRET_NAME} `));
      expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] verify[^\\n]*https://${HOST}/health`));
      expect(result.stdout).toMatch(/Bitwarden item/);
      expect(result.stdout).toMatch(/dry run/i);
      expect(calls(scratch)).not.toMatch(mutating);
      expect(calls(scratch)).not.toMatch(/^curl/m);
      expect(has(scratch, "worker") && has(scratch, "dns") && has(scratch, "secret")).toBe(true);
    });

    it("reports each already-gone resource as a pass", () => {
      const scratch = makeScratch({ worker: false, dns: false, secret: false });
      const result = run(scratch, ["--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Worker[^\n]*already gone/i);
      expect(result.stdout).toMatch(/DNS record[^\n]*already gone/i);
      expect(result.stdout).not.toMatch(/\[dry-run\] cf (workers|dns)/);
      expect(calls(scratch)).not.toMatch(mutating);
    });
  });

  describe("pre-flight", () => {
    it("stops, changing nothing, when cf is not on PATH", () => {
      const scratch = makeScratch();
      const empty = join(scratch.root, "empty");
      mkdirSync(empty);
      const result = run(scratch, [], {}, empty);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED[^\n]*cf/);
      expect(result.stderr).toMatch(/nothing was changed/);
      expect(has(scratch, "worker")).toBe(true);
    });

    it("stops when cf is not logged in", () => {
      const scratch = makeScratch();
      const result = run(scratch, [], { FAKE_UNAUTH: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED[^\n]*logged in/);
      expect(calls(scratch)).not.toMatch(mutating);
    });

    it("stops when another Worker still references the relay", () => {
      const scratch = makeScratch();
      const result = run(scratch, [], { FAKE_WORKER_REF: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED[^\n]*another Worker/);
      expect(calls(scratch)).not.toMatch(mutating);
      expect(has(scratch, "worker")).toBe(true);
    });

    it("stops when the Worker holds a domain other than the relay's", () => {
      const scratch = makeScratch();
      const result = run(scratch, [], { FAKE_OTHER_DOMAIN: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-flight FAILED[^\n]*domain/);
      expect(calls(scratch)).not.toMatch(mutating);
    });
  });

  describe("live run (fakes)", () => {
    it("deletes the Worker (and its Durable Object), the DNS record and the secret, then verifies", () => {
      const scratch = makeScratch();
      const result = run(scratch, []);
      expect(result.status).toBe(0);
      expect(has(scratch, "worker")).toBe(false);
      expect(has(scratch, "dns")).toBe(false);
      expect(has(scratch, "secret")).toBe(false);
      const log = calls(scratch);
      expect(log).toMatch(new RegExp(`cf workers delete ${WORKER} --force --delete-with-references`));
      expect(log).toMatch(new RegExp(`curl [^\\n]*https://${HOST}/health`));
      expect(log.indexOf("workers delete")).toBeLessThan(log.indexOf("curl"));
      expect(result.stdout).toMatch(/secret[^\n]*went with the Worker/i);
      expect(result.stdout).toMatch(/verify ok/);
      expect(result.stdout).toMatch(/Bitwarden item/);
      expect(output(result)).not.toContain(SECRET_VALUE);
    });

    it("deletes a DNS record that outlives the Worker, by id", () => {
      const scratch = makeScratch();
      const result = run(scratch, [], { FAKE_DNS_SURVIVES: "1" });
      expect(result.status).toBe(0);
      expect(calls(scratch)).toMatch(/cf dns records delete rec-1 -z myargus\.cc/);
      expect(has(scratch, "dns")).toBe(false);
    });

    it("is idempotent: a second run changes nothing and passes", () => {
      const scratch = makeScratch();
      expect(run(scratch, []).status).toBe(0);
      writeFileSync(scratch.log, "");
      const second = run(scratch, []);
      expect(second.status).toBe(0);
      expect(second.stdout).toMatch(/Worker[^\n]*already gone/i);
      expect(second.stdout).toMatch(/DNS record[^\n]*already gone/i);
      expect(calls(scratch)).not.toMatch(mutating);
    });

    it("exits non-zero and says so when the Worker delete is refused", () => {
      const scratch = makeScratch();
      const result = run(scratch, [], { FAKE_DELETE_FAILS: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/workers delete/);
      expect(has(scratch, "worker")).toBe(true);
    });

    it("exits non-zero when a DNS record survives and cannot be deleted", () => {
      const scratch = makeScratch();
      const result = run(scratch, [], { FAKE_DNS_SURVIVES: "1", FAKE_DNS_DELETE_FAILS: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/dashboard/i);
    });

    it("exits non-zero when the hostname still answers from the Worker", () => {
      const scratch = makeScratch();
      const result = run(scratch, [], { FAKE_DNS_SURVIVES: "1", FAKE_HEALTH_STICKS: "1" });
      expect(result.status).toBe(1);
      expect(output(result)).toMatch(/verify FAILED[^\n]*health/);
    });
  });

  it("never promotes, pushes, dispatches, deploys or prints a secret", () => {
    expect(code).not.toMatch(/promote\.sh|git push|gh workflow|gh api|deploy\.sh|wrangler/);
    expect(code).not.toMatch(/set -x|set -o xtrace/);
    expect(code).not.toMatch(/secrets (update|bulk|get)/);
  });

  it("holds no Cloudflare id, account name or secret value", () => {
    const text = readFileSync(script, "utf8");
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
    expect(text).not.toContain(SECRET_VALUE);
  });
});
