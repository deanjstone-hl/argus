import { describe, expect, it } from "vitest";
import { planJobs } from "./ci-changes.ts";

// A stand-in nested package: none exists today, but the planning still has to handle one.
const nestedPackages = ["sample"];

const everything = {
  root: true,
  nested: nestedPackages,
};

const plan = (files: string[] | undefined) => planJobs(files, nestedPackages);

describe("planJobs", () => {
  it("runs everything when the changed files are unknown", () => {
    expect(plan(undefined)).toEqual(everything);
  });

  it("runs only the nested package a change touches", () => {
    expect(plan(["apps/sample/src/index.ts"])).toEqual({
      root: false,
      nested: ["sample"],
    });
  });

  it("runs only the root workspace for a root package or docs change", () => {
    expect(plan(["apps/watchtower/src/app.ts", "docs/guide.md"])).toEqual({
      root: true,
      nested: [],
    });
  });

  it("combines root and nested when both change", () => {
    expect(plan(["packages/bearer-auth/index.js", "apps/sample/src/a.ts"])).toEqual({
      root: true,
      nested: ["sample"],
    });
  });

  it.each(["scripts/ci.sh", ".github/workflows/ci.yml", ".github/actions/host-pnpm/action.yml"])(
    "runs everything when shared CI plumbing (%s) changes",
    (path) => {
      expect(plan([path])).toEqual(everything);
    },
  );

  it("does not mistake a sibling directory with a nested package's prefix", () => {
    expect(plan(["apps/sample-notes/src/index.ts"])).toEqual({
      root: true,
      nested: [],
    });
  });

  it("starts no nested job while no package carries its own workspace", () => {
    expect(planJobs(["apps/watchtower/src/app.ts"])).toEqual({ root: true, nested: [] });
    expect(planJobs(undefined)).toEqual({ root: true, nested: [] });
  });

  it("runs nothing for an empty change", () => {
    expect(plan([])).toEqual({ root: false, nested: [] });
  });
});
