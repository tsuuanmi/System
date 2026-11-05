# Agent instructions

This file routes coding agents. Product facts belong in `docs/`, not in this file.

## Read before changing

1. Read [README.md](README.md) and [docs/README.md](docs/README.md).
2. Read [documentation governance](docs/governance/documentation.md) and the appropriate canonical or evolutionary documents.
3. Run `python3 tools/docs.py trace <path-or-ID>` for the proposed change (when the document or path is registered); inspect any related documents.
4. When implementation packages exist, read their nearest `README.md`, source, and tests. Each package README must state ownership, exclusions, entry points, dependencies, and governing documents.
5. Treat [the predecessor](https://github.com/tsuuanmi/system_1) as evidence, **not** as an authoritative specification or an implementation of this repository.

If source code and current documentation disagree, surface and resolve the mismatch; do not silently choose one.

## Change invariants

- Keep changes small, coherent, and production-quality.
- One authoritative implementation and one home per fact; no speculative frameworks, knobs, parallel runtimes, or compatibility layers.
- Do not import old architecture decisions without reviewing them for this repository.
- Proposed functionality remains in proposals until accepted; do not describe it as shipped.
- Make access, side effects, and human approval boundaries explicit before adding executable Workers or tools.

## Documentation is part of the change

Update the appropriate documentation alongside any behavior, module boundary, public contract, verification, or durable decision change. Declare typed relationships in front matter; do not maintain generated blocks by hand. Retire knowledge only with evidence and a recorded ledger entry, following [governance](docs/governance/documentation.md).

## Verification

Run `python3 tools/docs.py check` and `python3 tools/docs.py sync --check`. For changes that touch paths covered by documentation, run `python3 tools/docs.py impact <base-ref>`. Discover and run implementation-specific checks from CI once code exists. Do not weaken a check to make a change pass.

## Final review

Inspect the entire diff, check links and consistency, report verified results and unresolved questions, and never claim predecessor tests were executed against this new repository.
