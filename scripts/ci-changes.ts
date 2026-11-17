#!/usr/bin/env node
// Decides which CI jobs a change needs, so .github/workflows/ci.yml can skip the
// rest with a job-level `if:`. A skipped job never starts a runner.
//
//   node scripts/ci-changes.ts   in Actions: writes root / nested to $GITHUB_OUTPUT
//
// The changed files come from the REST API (the PR's files, or the push's compare
// range), so this needs no history in the checkout. Whenever the list can't be
// read in full, every job runs: a missed check costs more than a wasted slot.
// scripts/ci.sh --changed is the local pre-push equivalent; it narrows inside a
// job, this decides which jobs start at all.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Keep in step with nested_packages in scripts/ci.sh.
const nestedPackages: string[] = [];

// Files every job depends on: a change to any of them runs everything.
const sharedPrefixes = ["scripts/ci.sh", ".github/workflows/ci.yml", ".github/actions/"];

// GitHub's compare endpoint lists at most 300 files; the PR files endpoint 3,000.
const compareFileLimit = 300;
const pullFileLimit = 3000;

export interface JobPlan {
  root: boolean;
  nested: string[];
}

// `nested` defaults to the list above; the tests pass their own, since the list is empty
// while no package carries its own pnpm workspace.
export function planJobs(files: string[] | undefined, nested: string[] = nestedPackages): JobPlan {
  if (files === undefined || files.some((path) => sharedPrefixes.some((prefix) => path.startsWith(prefix)))) {
    return { root: true, nested: [...nested] };
  }

  const touched = new Set<string>();
  let root = false;
  for (const path of files) {
    const owner = nested.find((name) => path.startsWith(`apps/${name}/`));
    if (owner === undefined) {
      root = true;
    } else {
      touched.add(owner);
    }
  }

  return {
    root,
    nested: nested.filter((name) => touched.has(name)),
  };
}

async function getJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

interface ChangedFile {
  filename: string;
  previous_filename?: string;
}

// A rename touches both its old and its new directory.
function filenames(files: ChangedFile[]): string[] {
  return files.flatMap((file) =>
    file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
  );
}

async function pullRequestFiles(api: string, repo: string, number: number, token: string): Promise<string[] | undefined> {
  const files: ChangedFile[] = [];
  for (let page = 1; ; page++) {
    const batch = (await getJson(`${api}/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token)) as ChangedFile[];
    files.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return files.length >= pullFileLimit ? undefined : filenames(files);
}

async function pushFiles(api: string, repo: string, before: string, after: string, token: string): Promise<string[] | undefined> {
  if (/^0+$/.test(before)) {
    return undefined;
  }
  const comparison = (await getJson(`${api}/repos/${repo}/compare/${before}...${after}`, token)) as {
    files?: ChangedFile[];
  };
  if (comparison.files === undefined || comparison.files.length >= compareFileLimit) {
    return undefined;
  }
  return filenames(comparison.files);
}

async function changedFiles(): Promise<string[] | undefined> {
  const env = process.env;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!repo || !token || !eventPath) {
    console.log("ci-changes: not running in Actions with a token, so every job runs.");
    return undefined;
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
    pull_request?: { number: number };
    before?: string;
    after?: string;
  };

  try {
    if (env.GITHUB_EVENT_NAME === "pull_request" && event.pull_request) {
      return await pullRequestFiles(api, repo, event.pull_request.number, token);
    }
    if (env.GITHUB_EVENT_NAME === "push" && event.before && event.after) {
      return await pushFiles(api, repo, event.before, event.after, token);
    }
  } catch (error) {
    console.log(`ci-changes: ${(error as Error).message}, so every job runs.`);
  }
  return undefined;
}

async function main(): Promise<void> {
  const files = await changedFiles();
  const plan = planJobs(files);
  console.log(`ci-changes: ${files === undefined ? "file list unknown" : `${files.length} changed file(s)`}`);
  console.log(`ci-changes: root=${plan.root} nested=${JSON.stringify(plan.nested)}`);

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(
      outputPath,
      `root=${plan.root}\nnested=${JSON.stringify(plan.nested)}\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
