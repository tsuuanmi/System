#!/usr/bin/env python3
"""Create-only portable documentation bootstrap for a different repository.

Copies the product-agnostic standard and level-1 checker from this checkout,
then writes independent profile, routers, ledger and agent instructions.
Never overwrites existing files or imports System product documentation.
"""
from __future__ import annotations

import argparse
from pathlib import Path

ORIGIN = Path(__file__).resolve().parent.parent


def scaffold(name: str) -> dict[str, str]:
    return {
        "README.md": f"""# {name}

Project documentation: [docs/README.md](docs/README.md).
This is a documentation bootstrap, not an implementation.
""",
        "AGENTS.md": """# Agent instructions

## Read before changing

1. Read [README.md](README.md) and [docs/README.md](docs/README.md).
2. Read [the local documentation profile](docs/governance/documentation.md)
   and applicable canonical documents.
3. Run python3 tools/docs.py trace <path-or-ID> for an existing document or
   requirement, and inspect related documents.
4. When source exists, read the nearest owning source README, implementation,
   and tests. Research and proposals are never product authority.

## Change rules

Keep one home per fact, update current documentation with behavior,
declare typed relations in front matter, and never hand-edit generated blocks.
Add repository-specific architecture and security invariants here once decided.

## Verification

Run python3 tools/docs.py check and python3 tools/docs.py sync --check.
Run python3 tools/docs.py impact <base-ref> for changes to covered paths.
Discover and run other CI gates. Never suppress a failing gate.
""",
        "docs/README.md": f"""# {name} documentation

This router separates canonical truth from proposed and exploratory content.

- [Documentation governance](governance/README.md): current standards,
  ownership, retention and checks.

Create only documentation areas with real content. Update
[the repository profile](governance/documentation.md) when adding areas,
source roots or typed document IDs.
""",
        "docs/governance/README.md": """# Governance

Current documentation rules and portability mechanisms. No product features
or architecture belong here.

- [Portable standard](documentation-architecture.md)
- [Bootstrap guide](bootstrap.md)
- [Repository profile](documentation.md)
- [Retirement ledger](retired.md)
""",
        "docs/governance/documentation.md": f"""---
level: 1
areas: [governance=governance]
id-prefixes: []
source-roots: []
forbidden-names: [archive, archives, deprecated, history, legacy, old, temp, temporary]
ledger: governance/retired.md
reachability-depth: 3
review-days: 365
max-lines: 500
---

# {name} documentation profile

This repository adopts the [portable standard](documentation-architecture.md).
Its own areas, ID prefixes, source roots and conformance level are declared
above. Do not add areas without real content.

## Verification

Run python3 tools/docs.py check and python3 tools/docs.py sync --check;
on pull requests run python3 tools/docs.py impact <base-ref>. The bundled
checker is level 1 with additional limited graph checks, not complete
level 2 or level 3 conformance.

## Lifecycle

Keep one canonical home per fact. Proposals and research are not normative.
Retire only after folding live knowledge forward, rewriting links and recording
the old full text commit and path in [the ledger](retired.md).
""",
        "docs/governance/retired.md": """# Retired-document ledger

Append-only ledger. No documents have been retired.

| id | title | outcome | superseded-by | retired | full-text |
|---|---|---|---|---|---|
""",
    }


def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True,
                        help="Destination repository root")
    parser.add_argument("--name", default=None,
                        help="Target project's display name")
    args = parser.parse_args()
    output = args.out.expanduser().resolve()
    if output == ORIGIN:
        parser.error("bootstrap target must be a different repository")
    name = (args.name or output.name).strip()
    if not name or "\n" in name or "\r" in name:
        parser.error("--name must be a non-empty single line")
    source_files = {
        "docs/governance/documentation-architecture.md":
            "docs/governance/documentation-architecture.md",
        "docs/governance/bootstrap.md": "docs/governance/bootstrap.md",
        "tools/docs.py": "tools/docs.py",
        "tools/bootstrap_docs.py": "tools/bootstrap_docs.py",
        ".github/workflows/docs.yml": ".github/workflows/docs.yml",
    }
    data = {path: body.encode("utf-8")
            for path, body in scaffold(name).items()}
    for target, source in source_files.items():
        data[target] = (ORIGIN / source).read_bytes()

    created = []
    skipped = []
    for relative, contents in sorted(data.items()):
        path = output / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("xb") as handle:
                handle.write(contents)
            created.append(relative)
        except FileExistsError:
            skipped.append(relative)

    print(f"Created documentation skeleton for {name} in {output}")
    print(f"  created ({len(created)}): " + ", ".join(created))
    if skipped:
        print(f"  existing, not overwritten ({len(skipped)}): "
              + ", ".join(skipped))
        if "README.md" in skipped:
            print("  action: add a docs/README.md link to your existing root README")
    print("Next: review docs/governance/documentation.md and run:")
    print("  python3 tools/docs.py check")
    print("  python3 tools/docs.py sync --check")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
