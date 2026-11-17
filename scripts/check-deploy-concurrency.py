#!/usr/bin/env python3
"""Every workflow a `deploy` push triggers has a concurrency block (argus-config#1293).

Without one, two promotions in quick succession run every deploy twice. With
`concurrency: { group: <name>, cancel-in-progress: false }` GitHub replaces the pending
run with the newer one and lets the run in progress finish, so a newer promotion
supersedes a queued older one and never interrupts a deploy midway.

For every workflow file whose `on.push.branches` lists `deploy` this requires:
  - a workflow-level `concurrency` mapping (a job-level block does not count: the rule
    is one group per workflow, and a job-level group says nothing about the run)
  - a non-empty `group`
  - `cancel-in-progress` the literal boolean false (absent defaults to false only in
    GitHub's runtime, and an expression can turn it on for some events)
and across the directory that no two such workflows resolve to the same group, which
would queue unrelated deploys behind each other.

A workflow that runs on a deploy push but deploys nothing (a CI run the release job
reuses), or one that must keep a run per promotion, opts out with a comment line
`# deploy-concurrency-exempt: <reason>`. A marker with no reason does not count.

`${{ github.workflow }}` in a group resolves to the workflow's `name:` (the file name
when it has none) for the duplicate check.

Usage: python3 scripts/check-deploy-concurrency.py [workflows-dir ...]
       (default .github/workflows; exit 0 = clean, 1 = findings, 2 = usage error)

Self-contained and read-only, so a deploy repo's CI can call it from a copy.
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("check-deploy-concurrency.py needs PyYAML (python3-yaml / pip install pyyaml)")
    sys.exit(2)

DEFAULT_DIR = ".github/workflows"
WORKFLOW_EXPR = re.compile(r"\$\{\{\s*github\.workflow\s*\}\}")
EXEMPT = re.compile(r"^[ \t]*#[ \t]*deploy-concurrency-exempt:[ \t]*\S", re.MULTILINE)


def triggers(doc):
    """The `on` mapping. PyYAML reads the bare key `on` as the boolean True."""
    for key in ("on", True):
        if key in doc:
            return doc[key]
    return None


def pushes_to_deploy(doc):
    on = triggers(doc)
    if not isinstance(on, dict):
        return False
    push = on.get("push")
    if not isinstance(push, dict):
        return False
    branches = push.get("branches")
    if isinstance(branches, str):
        branches = [branches]
    return isinstance(branches, list) and "deploy" in branches


def check_file(path, doc):
    """(failures, resolved group or None) for one deploy-push workflow."""
    where = str(path)
    block = doc.get("concurrency")
    if block is None:
        return [
            f"{where}: no workflow-level concurrency block "
            "(add `concurrency: { group: ${{ github.workflow }}, cancel-in-progress: false }` "
            "at the top level; a job-level block does not count)"
        ], None
    if not isinstance(block, dict):
        return [
            f"{where}: concurrency must be a mapping with a group and "
            "cancel-in-progress: false (the string form leaves cancel-in-progress unset)"
        ], None

    failures = []
    group = block.get("group")
    if not isinstance(group, str) or not group.strip():
        failures.append(f"{where}: concurrency has no non-empty group")
        group = None
    if block.get("cancel-in-progress") is not False:
        failures.append(
            f"{where}: concurrency cancel-in-progress must be the literal false, "
            f"got {block.get('cancel-in-progress')!r}"
        )
    if group is not None:
        name = doc.get("name") if isinstance(doc.get("name"), str) else path.stem
        group = WORKFLOW_EXPR.sub(name, group).strip()
    return failures, group


def check_dir(directory):
    failures = []
    groups = {}
    checked = 0
    exempt = 0
    files = sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")])
    for path in files:
        try:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as e:
            first = str(e).splitlines()[0] if str(e) else type(e).__name__
            failures.append(f"{path}: cannot parse workflow ({first})")
            continue
        if not isinstance(doc, dict) or not pushes_to_deploy(doc):
            continue
        if EXEMPT.search(path.read_text(encoding="utf-8")):
            exempt += 1
            continue
        checked += 1
        found, group = check_file(path, doc)
        failures.extend(found)
        if group is not None:
            groups.setdefault(group, []).append(path)
    for group, paths in sorted(groups.items()):
        if len(paths) > 1:
            names = ", ".join(str(p) for p in paths)
            failures.append(f"concurrency group {group!r} is shared by {names}")
    return failures, checked, exempt


def main(argv):
    directories = [Path(a) for a in argv] or [Path(DEFAULT_DIR)]
    failures = []
    checked = 0
    exempt = 0
    for directory in directories:
        if not directory.is_dir():
            print(f"{directory}: not a directory")
            return 2
        found, count, skipped = check_dir(directory)
        failures.extend(found)
        checked += count
        exempt += skipped
    if failures:
        print("\n".join(failures))
        return 1
    note = f", {exempt} exempt" if exempt else ""
    print(f"OK: {checked} deploy-push workflow(s) carry a cancel-in-progress: false concurrency block{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
