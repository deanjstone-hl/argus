import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Host-wide heavy lock (argus-config#1506): two overlapping full checks made systemd-oomd kill
// agent scopes, so the gate (scripts/ci.sh: `pnpm check`, CI, the pre-push hook) takes the lock
// itself, from a copy of argus-config's scripts/heavy-lock.sh.

const scripts = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => readFileSync(join(scripts, name), "utf8");

describe("heavy lock", () => {
  it("has the vendored copy byte-identical to the sha256 in its lock file", () => {
    const sha = createHash("sha256").update(readFileSync(join(scripts, "heavy-lock.sh"))).digest("hex");
    expect(read("heavy-lock.lock")).toContain(`${sha}  heavy-lock.sh`);
  });

  it("ci.sh re-runs itself under the lock", () => {
    const ci = read("ci.sh");
    expect(ci).toContain("scripts/heavy-lock.sh");
    expect(ci).toContain("HEAVY_LOCK_HELD");
  });

  it("waits while another process holds the lock, and gives up with 75 without running a step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heavy-lock-"));
    const lockFile = join(dir, "heavy.lock");
    const holder = spawn("bash", ["-c", 'exec 9>>"$LOCK_FILE"; flock 9; echo held; sleep 30'], {
      env: { ...process.env, LOCK_FILE: lockFile },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("error", reject);
        holder.once("exit", () => reject(new Error("lock holder exited early")));
      });
      // The gate itself runs under the lock with HEAVY_LOCK_HELD=1: a nested call must not inherit it.
      const { HEAVY_LOCK_HELD: _held, ...env } = process.env;
      const result = spawnSync("bash", [join(scripts, "ci.sh"), "root"], {
        encoding: "utf8",
        env: { ...env, HEAVY_LOCK_FILE: lockFile, HEAVY_LOCK_TIMEOUT: "1", HEAVY_LOCK_PSI_FILE: join(dir, "none") },
        timeout: 30_000,
      });
      expect(result.status).toBe(75);
      expect(result.stderr).toContain("waiting for the host lock");
      expect(result.stdout).not.toContain("==>");
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
