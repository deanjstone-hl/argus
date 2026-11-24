import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/owner-steps/1207.sh is argus#1207's live step: the fresh-history public cutover,
// approved as one command. These tests never run it live: they read it, and run it only for
// its argument handling. The live behaviour was proven by its model, sys-admin's 194.sh, which
// ran on 16 Nov 2026.

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "owner-steps", "1207.sh");
const text = readFileSync(script, "utf8");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// The script's commands: no comments, no heredoc (the wiring text) and no plan or progress lines.
const commands = (source: string): string =>
  source
    .replace(/<<EOF\n[\s\S]*?\nEOF\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(#|want |echo |did )/.test(line))
    .join("\n");

const shellList = (name: string): string[] => {
  const match = new RegExp(`${name}=\\(([^)]*)\\)`).exec(text);
  return (match?.[1] ?? "").split(/\s+/).filter(Boolean);
};

describe("scripts/owner-steps/1207.sh", () => {
  it("parses as bash", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it.each([[["--live"]], [["--dry-run", "extra"]], [["x"]]])("exits 2 on arguments %j", (args) => {
    const result = spawnSync("bash", [script, ...args], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("has a --dry-run that changes nothing: every mutation sits after the dry-run exit", () => {
    const exit = text.indexOf('[dry-run] done: nothing was changed"\n  exit 0');
    expect(exit).toBeGreaterThan(-1);
    const before = commands(text.slice(0, exit));
    for (const mutation of [
      "gh repo create",
      "gh repo edit",
      "gh issue transfer",
      "gh secret set",
      "gh variable set",
      "gh label clone",
      "bws secret create",
      "-X PATCH",
      "-X PUT",
      "git -C \"$export_dir\" push",
    ]) {
      expect(before, mutation).not.toContain(mutation);
    }
  });

  it("never pushes deploy, runs promote.sh or starts a workflow", () => {
    expect(commands(text).replace(/"[^"\n]*"/g, '""')).not.toMatch(/push[^\n]*deploy|promote\.sh|gh workflow run|gh run /);
  });

  it("renames to argus-archive and keeps it private", () => {
    expect(text).toContain('ARCHIVE="argus-archive"');
    expect(text).toContain("repo_is_private \"$ARCHIVE\" || die");
  });

  it("makes the new repository public only after the transferred issues are scanned", () => {
    expect(text.indexOf("# 6. scan every open issue")).toBeLessThan(text.indexOf("# 7. public"));
    expect(text.indexOf("# 5. issues")).toBeLessThan(text.indexOf("# 6. scan every open issue"));
    expect(text).toContain("exit 3");
  });

  it("seeds exactly the Secrets Manager keys that .env.example and deploy.sh name", () => {
    const keys = shellList("VALUE_KEYS");
    expect(keys.sort()).toEqual(
      [
        "ARGUS_CLOUDFLARE_ACCOUNT_ID",
        "ARGUS_CLOUDFLARE_ZONE_ID",
        "ARGUS_D1_WATCHTOWER_DATABASE_ID",
        "ARGUS_TAILSCALE_IP_HOMELAB",
        "ARGUS_TAILSCALE_IP_WSL2",
      ].sort(),
    );
    const deploy = read("apps/watchtower-collector/deploy.sh");
    // 1207.sh is the record of the cutover, which seeded the D1 id under its first name; scripts/owner-steps/59.sh
    // renamed it (argus#59), and deploy.sh reads the new name.
    const renamed: Record<string, string> = { ARGUS_D1_WATCHTOWER_DATABASE_ID: "ARGUS_WATCHTOWER_D1_DATABASE_ID" };
    for (const key of keys) expect(deploy, key).toContain(renamed[key] ?? key);
  });

  it("maps every Actions secret a workflow reads to a Secrets Manager key", () => {
    const mapping = /DEFAULT_ACTIONS_SECRETS="([^"]*)"/.exec(text)?.[1] ?? "";
    const mapped = new Set(mapping.split(/\s+/).map((pair) => pair.split("=")[0]));
    const workflows = join(root, ".github", "workflows");
    const read_ = new Set<string>();
    for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
      const code = readFileSync(join(workflows, file), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      // BWS_ACCESS_TOKEN is the token that reads Secrets Manager (argus#59), not a value 1207.sh could store.
      for (const match of code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (!["GITHUB_TOKEN", "BWS_ACCESS_TOKEN"].includes(match[1])) read_.add(match[1]);
    }
    expect(read_.size).toBeGreaterThan(0);
    for (const name of read_) expect(mapped.has(name), `${name} has no Secrets Manager key in 1207.sh`).toBe(true);
  });

  it("names the repository state it expects and the guard's first-push red", () => {
    expect(text).toContain("argus-config#1440");
    expect(text).toContain("LNV-LGN5-wsl2-deploy");
    expect(text).toContain("DO NOT move ~/repos/argus");
    expect(text).toContain("OPS_HUB_PROMOTION_REPOS");
  });
});
