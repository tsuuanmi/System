# Agent instructions

This file routes coding agents. Product facts belong in `docs/`.

## Read before changing

1. Read [README.md](README.md) and the [knowledge router](docs/README.md).
2. Read the [System documentation profile](docs/governance/documentation.md)
   and relevant current, draft, proposal and research documents.
3. Run `python3 tools/docs.py trace <path-or-ID>` for each existing
   document or ID affected; read related documents.
4. When source exists, read its nearest source README, implementation and tests.
5. An external audit target is **evidence only**: never assume its decisions,
   package layout or release state apply to System.

When source and normative documentation disagree, reconcile the conflict.

## Change invariants

- Make the smallest coherent, production-quality change.
- One source of truth per fact; no parallel implementations or speculative
  abstractions without tested need.
- Keep task state independent of a specific Worker session, and treat
  side-effect retries, authority, egress and accounting as explicit review
  questions until contracts are accepted.
- Research and proposals cannot become product authority without promotion.
- Never claim shipped behavior from a diagram, roadmap or test proposal.

## Documentation updates

Update governing documents with code and validation changes. Put typed edges
in front matter; use [the portable standard](docs/governance/documentation-architecture.md).
Never edit generated blocks manually. Retire documents via ledger and proof,
not direct deletion.

## Verification

Run `python3 tools/docs.py check` and `python3 tools/docs.py sync --check`;
when source globs are declared, run `python3 tools/docs.py impact <base-ref>`.
Discover additional implementation checks from CI when they exist. Never
weaken gates to force a passing result.

## Final review

Inspect the diff and links, prove any new claims, and report what remains
unverified.
