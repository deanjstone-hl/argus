import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/ci/release-needed.sh is the first question of the Release workflow (argus#1168,
// argus-config#1167): does the promotion carry anything semantic-release would publish? When
// it does not (only chore/docs/ci/refactor/test commits since the last root tag) no test runs
// and no version is cut. It reads git history, never the push event, which lists 20 commits at
// most. The cases build a throwaway repo; nothing touches a remote.

const script = fileURLToPath(new URL("ci/release-needed.sh", import.meta.url));

const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let repo: string;
let output: string;

function git(...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, ...identity }, stdio: "ignore" });
}

function commit(subject: string, body = ""): void {
  git("commit", "-q", "--allow-empty", "-m", body ? `${subject}\n\n${body}` : subject);
}

function decide(): { release: string; log: string; status: number | null } {
  writeFileSync(output, "");
  const result = spawnSync("bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...identity, GITHUB_OUTPUT: output },
  });
  const written = readFileSync(output, "utf8").trim();
  return { release: written.replace(/^release=/, ""), log: `${result.stdout}${result.stderr}`, status: result.status };
}

beforeEach(() => {
  const work = mkdtempSync(join(tmpdir(), "release-needed-"));
  repo = join(work, "repo");
  output = join(work, "output");
  execFileSync("git", ["init", "-q", "-b", "deploy", repo]);
  commit("chore: start");
  git("tag", "v1.0.0");
});

afterEach(() => {
  rmSync(join(repo, ".."), { recursive: true, force: true });
});

describe("scripts/ci/release-needed.sh", () => {
  it("exists", () => {
    expect(existsSync(script)).toBe(true);
  });

  it("says release=false for a promotion of only chore, docs, ci, refactor and test commits", () => {
    for (const subject of ["chore: a", "docs: b", "ci: c", "refactor: d", "test: e", "chore(deps): f"]) commit(subject);
    const result = decide();
    expect(result.status).toBe(0);
    expect(result.release).toBe("false");
    expect(result.log).toContain("Nothing releasable since v1.0.0");
  });

  it("says release=false when nothing at all is new since the last tag", () => {
    expect(decide().release).toBe("false");
  });

  it.each([["feat: x"], ["fix: x"], ["perf: x"], ["feat(watchtower): x"], ["fix(email)!: x"], ["revert: x"], ['Revert "feat: x"']])(
    "says release=true when a commit is %s",
    (subject) => {
      commit("chore: before");
      commit(subject);
      commit("docs: after");
      expect(decide().release).toBe("true");
    },
  );

  it("says release=true for a BREAKING CHANGE in a commit body", () => {
    commit("chore: reshape", "BREAKING CHANGE: the config moved");
    expect(decide().release).toBe("true");
  });

  it("only reads commits after the last root tag", () => {
    commit("feat: already released");
    git("tag", "v1.1.0");
    commit("chore: since");
    expect(decide().release).toBe("false");
  });

  it("says release=true when the repo has no root tag yet", () => {
    git("tag", "-d", "v1.0.0");
    expect(decide().release).toBe("true");
  });

  it("is anchored on the root v-tag: a package tag newer than it does not hide a feat", () => {
    commit("feat: x");
    commit("chore: y");
    git("tag", "@argus/watchtower-v2.0.0");
    git("tag", "memory-mcp-abc1234");
    expect(decide().release).toBe("true");
  });

  it("reads git, not the push event, so a promotion longer than 20 commits still finds its feat", () => {
    commit("feat: buried");
    for (let index = 0; index < 25; index += 1) commit(`chore: filler ${index}`);
    expect(decide().release).toBe("true");
  });

  it("fails open: with no git history it says release=true rather than skipping a release", () => {
    const empty = mkdtempSync(join(tmpdir(), "release-needed-empty-"));
    try {
      writeFileSync(output, "");
      const result = spawnSync("bash", [script], {
        cwd: empty,
        encoding: "utf8",
        env: { ...process.env, ...identity, GITHUB_OUTPUT: output, GIT_CEILING_DIRECTORIES: join(empty, "..") },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8").trim()).toBe("release=true");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
