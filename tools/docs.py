#!/usr/bin/env python3
"""Dependency-free documentation bootstrap checker for System (level 1).

The normative standard is docs/governance/documentation-architecture.md.
This checker implements level 1 plus limited graph and generator checks; it
does not claim complete level 2/3 conformance. Run from any directory with Python 3.8+.
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys
import textwrap
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
PROFILE = "governance/documentation.md"
RELATIONS = ("implements", "decided-by", "covers", "verified-by",
             "supersedes", "evidence", "related")
FIELDS = {"id", "type", "status", "date", "created", "summary", "owners",
          "reviewed", "implementation", "family", "family-labels", "unverified",
          *RELATIONS}
PROFILE_FIELDS = {"level", "areas", "id-prefixes", "source-roots",
                  "forbidden-names", "ledger", "reachability-depth",
                  "review-days", "max-lines", "reviewed"}
STATUSES = {
    "proposal": {"draft", "proposed", "accepted", "rejected", "implementing",
                 "implemented", "superseded", "withdrawn"},
    "research": {"active", "concluded", "promoted"},
    "decision": {"proposed", "accepted", "rejected", "superseded",
                 "superseded-in-part", "deprecated"},
}
LIVING = {"draft", "active", "deprecated"}
MARKDOWN_LINK = re.compile(r"!?\[[^\]]+\]\(([^)\n]+)\)")
WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")
BLOCK = re.compile(r"(<!-- docs:begin ([^ ]+) -->\n)(.*?)(<!-- docs:end \2 -->)",
                   re.DOTALL)
HEADER = re.compile(r"^# (.+)$", re.MULTILINE)
ID_PATTERN = re.compile(r"^[A-Z][A-Z0-9]*-\d{4}$")
WAIVER = re.compile(r"docs-unchanged:\s*(\S+)\s*[-—–]+\s*(\S.*)")

def prose_only(text: str) -> str:
    """Ignore examples and code when checking authored document links."""
    text = re.sub(r"(?ms)^[ \t]*(```|~~~).*?^[ \t]*\1[ \t]*$", "", text)
    text = re.sub(r"(?m)^(?: {4}|\t).*?$", "", text)
    return re.sub(r"`[^`\n]*`", "", text)


MAX_PROSE = 120
LINK_ONLY = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:<?https?://\S+>?|!?\[[^\]]*\]\([^)\s]*\))[.,;:]?\s*$")


def long_prose_lines(text: str) -> list[int]:
    """Numbers of prose lines over MAX_PROSE characters; tables, fenced code, front matter,
    headings and a line that is only a URL or a link are excepted."""
    lines = text.split("\n")
    start = 0
    if lines[0] == "---":
        start = next((i + 1 for i in range(1, len(lines)) if lines[i] == "---"), 0)
    found, fence = [], ""
    for index in range(start, len(lines)):
        line = lines[index]
        marker = re.match(r"^[ \t]*(```|~~~)", line)
        if fence:
            if marker and marker.group(1) == fence:
                fence = ""
            continue
        if marker:
            fence = marker.group(1)
        elif (len(line) > MAX_PROSE and not re.match(r"^\s*(\||#)", line)
              and not LINK_ONLY.match(line)):
            found.append(index + 1)
    return found


def front_matter(text: str, path: str, errors: list[str]) -> tuple[dict[str, list[str]], str]:
    if not text.startswith("---\n"):
        return {}, text
    closing = text.find("\n---\n", 4)
    if closing == -1:
        errors.append(f"DOC-ID-003 {path}: unclosed front matter")
        return {}, text
    fm: dict[str, list[str]] = {}
    current = ""
    for number, line in enumerate(text[4:closing].splitlines(), 2):
        match = re.fullmatch(r"([a-z][a-z-]*):(?:\s*(.*))?", line)
        if match:
            current = match.group(1)
            if current in fm:
                errors.append(f"DOC-ID-001 {path}:{number}: duplicate {current}")
            raw = (match.group(2) or "").strip()
            if raw.startswith("[") and raw.endswith("]"):
                value = [part.strip() for part in raw[1:-1].split(",") if part.strip()]
            elif raw:
                value = [raw.strip("\"'")]
            else:
                value = []
            fm[current] = value
        elif line.startswith("  - ") and current:
            fm[current].append(line[4:].strip())
        elif line.strip():
            errors.append(f"DOC-ID-001 {path}:{number}: expected flat YAML field/list")
    return fm, text[closing + 5:]


def first(meta: dict[str, list[str]], key: str, default: str = "") -> str:
    return next(iter(meta.get(key, [])), default)


@dataclass
class Document:
    rel: str
    path: Path
    meta: dict[str, list[str]]
    body: str
    kind: str
    identity: str
    doc_id: str
    router: bool


class Graph:
    def __init__(self) -> None:
        self.errors: list[str] = []
        if not (DOCS / PROFILE).is_file():
            raise ValueError(f"missing docs/{PROFILE}")
        self.profile, _ = front_matter(
            (DOCS / PROFILE).read_text(encoding="utf-8"), f"docs/{PROFILE}", self.errors
        )
        self.areas = dict(self.pairs("areas"))
        self.prefixes = dict(self.pairs("id-prefixes"))
        self.forbidden = set(self.profile.get("forbidden-names", []))
        self.docs: list[Document] = []
        self.by_id: dict[str, Document] = {}
        self.by_identity: dict[str, Document] = {}
        self.by_name: dict[str, list[Document]] = defaultdict(list)
        self.scan()

    def pairs(self, field: str) -> list[tuple[str, str]]:
        result = []
        for pair in self.profile.get(field, []):
            if "=" not in pair:
                self.errors.append(f"DOC-ID-001 docs/{PROFILE}: bad {field} value: {pair}")
            else:
                result.append(tuple(pair.split("=", 1)))
        return result

    def scan(self) -> None:
        for path in sorted(DOCS.rglob("*.md")):
            rel = path.relative_to(DOCS).as_posix()
            text = path.read_text(encoding="utf-8")
            meta, body = front_matter(text, f"docs/{rel}", self.errors)
            area = rel.split("/", 1)[0]
            kind = first(meta, "type", self.areas.get(area, ""))
            router = path.name == "README.md"
            identity = path.parent.relative_to(DOCS).as_posix() if router else rel[:-3]
            if identity == ".":
                identity = ""
            doc = Document(rel, path, meta, body, kind, identity,
                           first(meta, "id"), router)
            self.docs.append(doc)
            self.by_identity[identity] = doc
            self.by_name[path.stem].append(doc)
            if doc.doc_id:
                if doc.doc_id in self.by_id:
                    self.errors.append(f"DOC-ID-002 docs/{rel}: duplicate {doc.doc_id}")
                self.by_id[doc.doc_id] = doc

    def resolve(self, target: str) -> Document | None:
        target = target.split("|", 1)[0].split("#", 1)[0].strip()
        if target in self.by_id:
            return self.by_id[target]
        if target in self.by_identity:
            return self.by_identity[target]
        matches = self.by_name.get(target, [])
        return matches[0] if len(matches) == 1 else None

    def links(self, doc: Document) -> set[str]:
        linked: set[str] = set()
        for raw in MARKDOWN_LINK.findall(prose_only(doc.body)):
            target = unquote(raw.split("#", 1)[0].strip().strip("<>").split(" ", 1)[0])
            if not target or re.match(r"^[A-Za-z]+:", target):
                continue
            dest = (doc.path.parent / target).resolve()
            if dest.is_file() and dest.suffix == ".md" and DOCS in dest.parents:
                linked.add(dest.relative_to(DOCS).as_posix())
        for raw in WIKILINK.findall(prose_only(doc.body)):
            resolved = self.resolve(raw)
            if resolved is not None:
                linked.add(resolved.rel)
        return linked

    @staticmethod
    def source_directories(source: Path) -> list[Path]:
        """Directories under a source root that hold files git does not ignore."""
        try:
            listed = subprocess.run(
                ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", str(source)],
                cwd=ROOT, check=True, capture_output=True, text=True,
            ).stdout.splitlines()
        except (OSError, subprocess.CalledProcessError):
            return [source, *(p for p in source.rglob("*") if p.is_dir())]
        directories = {source}
        for file in listed:
            parent = (ROOT / file).parent
            while parent != source and source in parent.parents:
                directories.add(parent)
                parent = parent.parent
        return sorted(directories)

    def check_structure(self) -> None:
        for name in ("README.md", "AGENTS.md", "docs/README.md"):
            if not (ROOT / name).is_file():
                self.errors.append(f"DOC-STR-001 missing {name}")
        if (DOCS / "src").exists():
            self.errors.append("DOC-STR-003 docs/src mirror is forbidden")
        for directory in [DOCS, *(p for p in DOCS.rglob("*") if p.is_dir())]:
            rel = directory.relative_to(DOCS).as_posix()
            if directory != DOCS and directory.name.lower() in self.forbidden:
                self.errors.append(f"DOC-STR-004 forbidden directory docs/{rel}")
            if not (directory / "README.md").is_file():
                self.errors.append(f"DOC-STR-001 missing docs/{rel}/README.md")
            sibling = directory.with_suffix(".md")
            if directory != DOCS and sibling.is_file():
                self.errors.append(f"DOC-STR-003 duplicate router {sibling}")
        for file in DOCS.rglob("*"):
            if file.is_file() and file.stem.lower() in self.forbidden:
                self.errors.append(f"DOC-STR-004 forbidden name {file.relative_to(ROOT)}")
        for root in self.profile.get("source-roots", []):
            roots = sorted(ROOT.glob(root))
            if not roots:
                self.errors.append(f"DOC-STR-002 unmatched source-root: {root}")
            for source in roots:
                if source.is_dir():
                    for directory in self.source_directories(source):
                        if not (directory / "README.md").exists():
                            self.errors.append(
                                f"DOC-STR-002 missing {directory.relative_to(ROOT)}/README.md"
                            )
        files = [ROOT / "README.md", ROOT / "AGENTS.md",
                 *(p for p in DOCS.rglob("*.md"))]
        for file in files:
            if not file.exists():
                continue
            text = file.read_text(encoding="utf-8")
            if DOCS in file.parents:
                for number in long_prose_lines(text):
                    self.errors.append(
                        f"DOC-LEN-001 {file.relative_to(ROOT)}:{number}: prose line over {MAX_PROSE} characters"
                    )
            for raw in MARKDOWN_LINK.findall(prose_only(text)):
                target = unquote(raw.split("#", 1)[0].strip().strip("<>").split(" ", 1)[0])
                if not target or re.match(r"^[A-Za-z]+:", target):
                    continue
                path = (file.parent / target).resolve()
                inside_root = path == ROOT or ROOT in path.parents
                if not inside_root or not path.exists():
                    self.errors.append(
                        f"DOC-LNK-001 {file.relative_to(ROOT)}: broken link {raw}"
                    )

    def check_identity_links(self) -> None:
        for doc in self.docs:
            path = f"docs/{doc.rel}"
            allowed = PROFILE_FIELDS if doc.rel == PROFILE else FIELDS
            for key in doc.meta:
                if key not in allowed:
                    self.errors.append(f"DOC-ID-001 {path}: unknown field {key}")
            if doc.kind == "":
                if doc.rel != "README.md":
                    self.errors.append(f"DOC-ID-001 {path}: no document type")
            elif doc.kind != self.areas.get(doc.rel.split("/")[0], doc.kind):
                self.errors.append(f"DOC-ID-001 {path}: type conflicts with area")
            prefix = self.prefixes.get(doc.kind)
            if prefix and not doc.router:
                if not doc.doc_id or not doc.path.stem.startswith(doc.doc_id + "-"):
                    self.errors.append(f"DOC-ID-002 {path}: id must prefix filename")
                if not doc.doc_id or not ID_PATTERN.fullmatch(doc.doc_id):
                    self.errors.append(f"DOC-ID-002 {path}: missing/invalid ID")
                if not doc.doc_id.startswith(prefix + "-"):
                    self.errors.append(f"DOC-ID-002 {path}: wrong prefix")
                if not first(doc.meta, "status"):
                    self.errors.append(f"DOC-ID-003 {path}: status required")
            status = first(doc.meta, "status", "active")
            valid = STATUSES.get(doc.kind, LIVING)
            if not doc.router and status not in valid:
                self.errors.append(f"DOC-ID-003 {path}: invalid {doc.kind} status {status}")
            if not doc.router and doc.kind == "proposal" and not (first(doc.meta, "created") or first(doc.meta, "date")):
                self.errors.append(f"DOC-ID-003 {path}: creation date required")
            for raw in WIKILINK.findall(prose_only(doc.body)):
                if self.resolve(raw) is None:
                    self.errors.append(f"DOC-LNK-002 {path}: unresolved [[{raw}]]")
            for relation in RELATIONS:
                for target in doc.meta.get(relation, []):
                    if relation in ("covers", "verified-by") and any(
                        fnmatch.fnmatch(p.relative_to(ROOT).as_posix(), target)
                        for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts
                    ):
                        continue
                    if self.resolve(target) is None:
                        self.errors.append(f"DOC-LNK-005 {path}: unresolved {relation}: {target}")

    def check_reachability(self) -> None:
        index = self.by_identity.get("")
        if not index:
            return
        depth = int(first(self.profile, "reachability-depth", "3"))
        visited = {index.rel}
        pending = deque([(index, 0)])
        by_rel = {doc.rel: doc for doc in self.docs}
        while pending:
            node, hops = pending.popleft()
            if hops >= depth:
                continue
            for rel in self.links(node):
                if rel in by_rel and rel not in visited:
                    visited.add(rel)
                    pending.append((by_rel[rel], hops + 1))
        for doc in self.docs:
            if doc.rel not in visited:
                self.errors.append(f"DOC-GRF-002 docs/{doc.rel}: unreachable from docs/README.md")

    def generate(self, doc: Document, name: str) -> str:
        if not name.startswith("index:"):
            raise ValueError(f"unsupported generated block: {name}")
        kind = name[len("index:"):]
        entries = sorted(
            (d for d in self.docs if d.kind == kind and not d.router and d.doc_id),
            key=lambda d: d.doc_id
        )
        rows = []
        for entry in entries:
            title_match = HEADER.search(entry.body)
            title = title_match.group(1) if title_match else entry.doc_id
            summary = first(entry.meta, "summary")
            target = os.path.relpath(entry.path, doc.path.parent).replace(os.sep, "/")
            row = (f"- [{entry.doc_id} — {title}]({target}) — "
                   f"{first(entry.meta, 'status', 'active')} — {summary}")
            rows.append(textwrap.fill(row, MAX_PROSE, subsequent_indent="  ",
                                      break_long_words=False, break_on_hyphens=False))
        return "\n".join(rows) + ("\n" if rows else "")

    def sync(self, check: bool) -> int:
        changed = []
        for doc in self.docs:
            text = doc.path.read_text(encoding="utf-8")
            def replace(match: re.Match[str]) -> str:
                try:
                    generated = self.generate(doc, match.group(2))
                except ValueError as exc:
                    self.errors.append(f"DOC-GEN-001 docs/{doc.rel}: {exc}")
                    return match.group(0)
                return match.group(1) + generated + match.group(4)
            updated = BLOCK.sub(replace, text)
            if updated != text:
                changed.append(f"docs/{doc.rel}")
                if not check:
                    doc.path.write_text(updated, encoding="utf-8")
        if changed:
            print(("Stale" if check else "Updated") + " generated blocks: " + ", ".join(changed))
        if self.errors:
            print("\n".join(self.errors), file=sys.stderr)
        return int(bool(self.errors or (check and changed)))

    def trace(self, target: str) -> int:
        source = self.resolve(target.removeprefix("docs/").removesuffix(".md"))
        if source is None:
            print(f"Unknown document or ID: {target}", file=sys.stderr)
            return 1
        adjacency: dict[str, set[str]] = defaultdict(set)
        for doc in self.docs:
            for field in RELATIONS:
                for name in doc.meta.get(field, []):
                    dest = self.resolve(name)
                    if dest:
                        adjacency[doc.rel].add(dest.rel)
                        adjacency[dest.rel].add(doc.rel)
        seen = {source.rel}
        queue = deque([source.rel])
        while queue:
            rel = queue.popleft()
            for nxt in sorted(adjacency[rel]):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        for rel in sorted(seen):
            doc = next(d for d in self.docs if d.rel == rel)
            print(f"docs/{rel}" + (f" [{doc.doc_id}]" if doc.doc_id else ""))
        return 0

    def impact(self, base: str) -> int:
        try:
            output = subprocess.check_output(
                ["git", "diff", "--name-only", f"{base}...HEAD"],
                cwd=ROOT, text=True, stderr=subprocess.PIPE
            )
        except subprocess.CalledProcessError as exc:
            print(exc.stderr.strip(), file=sys.stderr)
            return 1
        changed = set(output.splitlines())
        waivers = {m.group(1) for m in WAIVER.finditer(os.environ.get("PR_BODY", ""))}
        errors = []
        for doc in self.docs:
            patterns = doc.meta.get("covers", [])
            if patterns and any(fnmatch.fnmatch(path, pattern)
                                for path in changed for pattern in patterns):
                path = f"docs/{doc.rel}"
                if path not in changed and path not in waivers:
                    errors.append(f"DOC-IMP-001 {path}: covered path changed; update it or waive in PR")
        if errors:
            print("\n".join(errors), file=sys.stderr)
        return int(bool(errors))

    def check(self) -> int:
        self.check_structure()
        self.check_identity_links()
        self.check_reachability()
        if self.errors:
            print("\n".join(self.errors), file=sys.stderr)
            return 1
        print(f"Documentation validated: {len(self.docs)} documents (profile level "
              f"{first(self.profile, 'level', '?')})")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    sync = sub.add_parser("sync")
    sync.add_argument("--check", action="store_true")
    trace = sub.add_parser("trace")
    trace.add_argument("target")
    impact = sub.add_parser("impact")
    impact.add_argument("base")
    opts = parser.parse_args()
    try:
        graph = Graph()
        if opts.command == "check":
            return graph.check()
        if opts.command == "sync":
            return graph.sync(opts.check)
        if opts.command == "trace":
            return graph.trace(opts.target)
        if opts.command == "impact":
            return graph.impact(opts.base)
    except (OSError, ValueError) as exc:
        print(f"docs: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
