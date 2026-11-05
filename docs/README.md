# System knowledge router

Use this index to distinguish **current repository truth** from background research and unapproved plans. At bootstrap, System has documentation and tooling but no product implementation. The predecessor is [system_1](https://github.com/tsuuanmi/system_1); its documents and decisions are not binding here.

| Question | Where to read | Authority |
|---|---|---|
| How are documents organized, checked, and retired? | [Governance](governance/README.md) | Current repository policy |
| What might the next System become? | [Proposals](proposals/README.md) | Under review, not production truth |
| What do we know about the predecessor and alternatives? | [Research](research/README.md) | Evidence, not a specification |

## Change workflow

Start with a proposal for an unaccepted change. When decisions are accepted, promote their durable rationale into a decision record, intended behavior into requirements, responsibilities into architecture, and mechanisms into design **as those areas acquire real content**. Implementation and tests, once present, are the executable reality. Never invent a documentation area solely to fill a template.

The [documentation profile](governance/documentation.md) selects the currently used areas and conformance level. Folder READMEs orient; authored document relationships carry meaning; generated indexes are refreshed by the documentation tool.

## Reading rules

- One fact has one home. Link rather than repeat it.
- Proposals and research cannot silently become canonical requirements.
- Documentation changes travel with the behavior they describe.
- A document's status is in its front matter when lifecycle metadata is needed.
