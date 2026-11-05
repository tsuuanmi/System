# @system/artifacts

The `artifacts` row: provides `ctx.artifacts`, immutable, typed,
content-addressed Artifacts
([ADR-0003](../../docs/decisions/ADR-0003-artifact-ids-and-verification-contracts.md),
[architecture](../../docs/architecture/artifact-verification.md)).

- **Injects:** `storageDomain` and `attachments`. It opens the DSH storage
  domain `system_artifacts` (version 1, SQLite) with one table, `artifacts`;
  it adds no database of its own.
- **Record:** one key per Artifact ID, holding the envelope and every
  occurrence. A new Artifact is one `put`; equal content produced again is one
  atomic `update` that appends an occurrence.
- **Bytes:** a blob Artifact's bytes go to the DSH attachment store
  (`$DSH_HOME/attachments/v1`), addressed by their own sha256 and verified on
  read. Inline content is limited to 256 KiB of canonical JSON.
- **Kinds:** a kind is registered with its schema version and either a zod
  content schema or `blob: true`. Only `file@1` (bytes) is built in; later
  milestones register theirs. An unknown kind or version is refused.

## Operations

| Call | Result |
|---|---|
| `put(input)` | validate inline content, store, return the envelope (the stored one on deduplication) |
| `putBytes(input)` | save the bytes, then the record |
| `get(id)` | `{ state: 'stored', envelope, occurrences }` or `{ state: 'missing' }`; a copy |
| `readBytes(id)` | the exact bytes, or `ArtifactError('unavailable')` when the record outlived them |

Refusals are `ArtifactError` with a `code`: `unknown-kind`, `invalid-content`,
`unknown-input`, `too-large`, `stricter-on-dedup`, `invalid-id`, `unavailable`.

## Invariants (tested)

- The ID is `artifact-id/v1`: `sha256` over the domain tag `system.artifact/v1`
  and the canonical JSON of `kind`, `schemaVersion`, `content` or
  `blob.{attachmentId, mediaType}`, sorted `inputs`, `subject` and `lineage`.
  Producer, time, classification and byte count are not part of it.
- Every input and superseded ID must be stored; a derived Artifact is at least
  as strict as its strictest input. Deduplication never relabels stored
  content: a stricter request is refused.
- Write order: bytes, then record. A crash between them leaves only an
  unreferenced, content-addressed blob that a retry reuses. A record whose
  bytes are later deleted reads as `unavailable`.
- Writes of one ID are serialized in process, because a DSH write is durable
  before it is visible in memory.

## Not in M1

Read authorization per caller (MVP-0 has one operator), garbage collection of
orphan blobs (the attachment store never deletes), listing and search.

## Reuse

[`src/canonical.ts`](src/canonical.ts) is ported from System 1
(`tsuuanmi/system` `f199a27`, `packages/libs/src/canonical.ts`) with the
owner's permission; several [tests](tests/README.md) adapt System 1's artifact
conformance suite.
