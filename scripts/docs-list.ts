#!/usr/bin/env node
// Prints an index of the repo's docs so an agent can pick which one to open, and
// fails when a doc lacks the `summary:` / `read_when:` front matter the index is
// built from. See docs/system-specs/common/repo-structure-standard.md, "Docs index".
//
//   node scripts/docs-list.ts [repo-root]           print the index
//   node scripts/docs-list.ts --check [repo-root]   validate only (CI)
//
// Walks <repo-root>/docs/ (default: the current directory). `archive/` and
// `research/` are point-in-time records, not onboarding material, so they are
// skipped, as are `_`-prefixed files (templates such as docs/decisions/_template.md).
// No YAML dependency: only the two fields this script owns are read, in the
// shapes the standard allows.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface DocEntry {
  path: string;
  summary: string;
  readWhen: string[];
}

interface FrontMatter {
  summary: string;
  readWhen: string[];
}

const skippedDirectories = new Set(["archive", "research"]);

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontMatter(text: string): FrontMatter | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;

  let summary = "";
  const readWhen: string[] = [];
  let inReadWhenList = false;

  for (const line of lines.slice(1, end)) {
    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (inReadWhenList && listItem) {
      readWhen.push(unquote(listItem[1]));
      continue;
    }
    inReadWhenList = false;

    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, value] = field;
    if (key === "summary") {
      summary = unquote(value);
    } else if (key === "read_when") {
      const inline = /^\[(.*)\]$/.exec(value.trim());
      if (inline) {
        readWhen.push(...inline[1].split(",").map(unquote).filter(Boolean));
      } else if (value.trim() === "") {
        inReadWhenList = true;
      } else {
        readWhen.push(unquote(value));
      }
    }
  }

  return { summary, readWhen };
}

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...markdownFiles(join(directory, entry.name)));
    } else if (entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

export function listDocs(repoRoot: string): { entries: DocEntry[]; errors: string[] } {
  const entries: DocEntry[] = [];
  const errors: string[] = [];
  const files = markdownFiles(join(repoRoot, "docs"))
    .map((file) => relative(repoRoot, file).split(sep).join("/"))
    .sort();

  for (const path of files) {
    const frontMatter = parseFrontMatter(readFileSync(join(repoRoot, path), "utf8"));
    if (!frontMatter) {
      errors.push(`${path}: no front matter (needs summary and read_when)`);
      continue;
    }
    if (!frontMatter.summary) errors.push(`${path}: missing summary`);
    if (frontMatter.readWhen.length === 0) errors.push(`${path}: missing read_when`);
    if (frontMatter.summary && frontMatter.readWhen.length > 0) {
      entries.push({ path, ...frontMatter });
    }
  }

  return { entries, errors };
}

export function formatIndex(entries: DocEntry[]): string {
  return entries
    .map((entry) => `${entry.path} — ${entry.summary}\n  read when: ${entry.readWhen.join("; ")}\n`)
    .join("");
}

function main(args: string[]): number {
  const check = args.includes("--check");
  const repoRoot = args.find((arg) => arg !== "--check") ?? process.cwd();
  const { entries, errors } = listDocs(repoRoot);

  if (!check) process.stdout.write(formatIndex(entries));
  if (errors.length > 0) {
    process.stderr.write(
      `docs-list: ${errors.length} problem(s) — every doc needs summary: and read_when: front matter\n`,
    );
    for (const error of errors) process.stderr.write(`  ${error}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
