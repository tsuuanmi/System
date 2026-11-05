# System knowledge router

This index distinguishes **current repository truth** from proposals and future implementation. System begins as a fresh project. At bootstrap the repository has documentation and tooling, but no product implementation.

| Question | Where to read | Authority |
|---|---|---|
| How are documents organized, checked, and retired? | [Governance](governance/README.md) | Current repository policy |
| What direction should System take? | [Proposals](proposals/README.md) | Under review; not current production behavior |

## Change workflow

Start with a proposal for an unaccepted change. Once decisions are made, record durable rationale in decisions, intended behavior in requirements, responsibility boundaries in architecture, and mechanisms in design **when these areas have real content**. Source and tests, once present, are executable reality. Do not create areas only to fill a template.

The [documentation profile](governance/documentation.md) selects the areas currently in use and the conformance level. Folder READMEs orient. Authored document relationships carry meaning; generated indexes are refreshed by tooling.

## Reading rules

- One fact has one home. Link rather than repeat it.
- Proposals cannot silently become canonical requirements.
- Documentation changes travel with the behavior they describe.
- Lifecycle metadata belongs in front matter where needed.
