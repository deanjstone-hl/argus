import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatIndex, listDocs, parseFrontMatter } from "./docs-list.ts";

const fixtures = fileURLToPath(new URL("./fixtures/docs-list/", import.meta.url));
const script = fileURLToPath(new URL("./docs-list.ts", import.meta.url));

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("parseFrontMatter", () => {
  it("reads a summary and a block-list read_when", () => {
    const parsed = parseFrontMatter(
      "---\nsummary: One line\nread_when:\n  - first\n  - 'second: quoted'\n---\nbody\n",
    );
    expect(parsed).toEqual({ summary: "One line", readWhen: ["first", "second: quoted"] });
  });

  it("reads an inline-list read_when and a quoted summary", () => {
    const parsed = parseFrontMatter('---\nsummary: "Quoted"\nread_when: [a, b]\n---\n');
    expect(parsed).toEqual({ summary: "Quoted", readWhen: ["a", "b"] });
  });

  it("returns undefined when the file has no front matter", () => {
    expect(parseFrontMatter("# Title\n")).toBeUndefined();
  });

  it("ignores keys other than summary and read_when", () => {
    const parsed = parseFrontMatter("---\ntitle: T\ntags: [x]\nsummary: S\n---\n");
    expect(parsed).toEqual({ summary: "S", readWhen: [] });
  });
});

describe("listDocs", () => {
  it("indexes every markdown doc outside archive/, research/ and _-prefixed files", () => {
    const { entries, errors } = listDocs(`${fixtures}valid`);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      {
        path: "docs/README.md",
        summary: "Map of the docs tree",
        readWhen: ["you are new to the repo", "you need to find a doc: any doc"],
      },
      {
        path: "docs/guides/deploy.md",
        summary: "How a package deploys",
        readWhen: ["shipping a package", "a deploy failed"],
      },
    ]);
  });

  it("reports each doc missing summary or read_when", () => {
    const { entries, errors } = listDocs(`${fixtures}invalid`);
    expect(entries).toEqual([]);
    expect(errors).toEqual([
      "docs/no-front-matter.md: no front matter (needs summary and read_when)",
      "docs/reference/empty-fields.md: missing summary",
      "docs/reference/empty-fields.md: missing read_when",
      "docs/reference/missing-read-when.md: missing read_when",
    ]);
  });
});

describe("formatIndex", () => {
  it("prints one line per doc with its triggers beneath", () => {
    const text = formatIndex([
      { path: "docs/a.md", summary: "A doc", readWhen: ["x", "y"] },
    ]);
    expect(text).toBe("docs/a.md — A doc\n  read when: x; y\n");
  });
});

describe("CLI", () => {
  it("prints the index and exits 0 when every doc is valid", () => {
    const result = runCli([`${fixtures}valid`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs/guides/deploy.md — How a package deploys");
  });

  it("prints nothing with --check when every doc is valid", () => {
    const result = runCli(["--check", `${fixtures}valid`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 1 and names the failing docs on stderr", () => {
    const result = runCli(["--check", `${fixtures}invalid`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/reference/missing-read-when.md: missing read_when");
  });
});
