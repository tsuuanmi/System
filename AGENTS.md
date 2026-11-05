# Agent instructions

This file routes coding agents. Product facts belong in `docs/`, not here.

## Read before changing

1. Read [README.md](README.md) and [docs/README.md](docs/README.md).
2. Read [documentation governance](docs/governance/documentation.md) and the appropriate canonical or evolutionary documents.
3. Run `python3 tools/docs.py trace <path-or-ID>` for an existing document or ID; inspect the related documentation.
4. When implementation packages exist, read their nearest `README.md`, source, and tests. Package READMEs describe ownership, exclusions, entry points, dependency direction, and governing documents.
5. Proposals are context only until accepted and promoted to canonical documentation.

If source and normative documentation disagree, surface and reconcile the mismatch rather than silently picking one.

## Change invariants

- Keep changes small, coherent, and production-quality.
- One authoritative implementation and one home per fact; no speculative frameworks, knobs, parallel runtimes, or compatibility layers.
- Make access, side effects, trust boundaries, and operator approval explicit before adding executable Workers or tools.
- Never claim a feature is shipped without implementation and evidence.

## Documentation is part of the change

Update the appropriate documentation alongside any behavior, module boundary, public contract, verification, or durable decision change. Declare typed relationships in front matter; do not maintain generated blocks by hand. Retire knowledge only with evidence and a recorded ledger entry, following [governance](docs/governance/documentation.md).

## Verification

Run `python3 tools/docs.py check` and `python3 tools/docs.py sync --check`. For changes affecting paths covered by documentation, run `python3 tools/docs.py impact <base-ref>`. Discover and run implementation-specific checks from CI once code exists. Do not weaken a check to make a change pass.

## Final review

Inspect the diff; check links and consistency; report verified results and unresolved questions.
