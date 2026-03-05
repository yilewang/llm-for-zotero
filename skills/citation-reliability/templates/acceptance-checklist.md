# Citation Reliability Acceptance Checklist

Use this checklist in PR descriptions for citation-related work.

## Scope

- [ ] Task explicitly involves citation parsing/matching/linking behavior.
- [ ] `citation-reliability` skill workflow was followed.

## Design Decisions

- [ ] Citation type split documented (blockquote vs inline/general).
- [ ] Match-priority order documented (`citationId` -> `citationKey` -> exact -> fuzzy).
- [ ] Low-confidence handling documented (do not link).
- [ ] Backward compatibility strategy documented.

## Implementation

- [ ] Parser supports machine token extraction without leaking token in visible UI.
- [ ] Resolver respects deterministic priority and does not downgrade to fuzzy when exact deterministic match exists.
- [ ] Quote citations still prioritize page jump.
- [ ] General citations open target PDF.
- [ ] Debug/telemetry mode labels are available (`cid|key|exact|fuzzy|none`).

## Tests

- [ ] Unit tests updated.
- [ ] At least one ambiguity test added/updated.
- [ ] At least one malformed citation test added/updated.
- [ ] At least one integration-style render/decorate test path added/updated.
- [ ] Existing citation tests still pass.

## Risk Review

- [ ] No wrong-paper link created under low confidence.
- [ ] No regression for legacy outputs without machine IDs.
- [ ] No stale active-reader/page cache hijack.
