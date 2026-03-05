# citation-reliability

## Purpose

Provide a decision-complete workflow to design and implement robust citation parsing, citation-to-paper matching, and click navigation behavior in `llm-for-zotero`.

## When To Use

Use this skill when a task involves:
- citation labels/chips in assistant output
- quote citation page-jump behavior
- inline/general citation linking to papers
- citation ambiguity handling
- deterministic matching (`citationId`, `citationKey`, author-year)
- citation parsing regressions/tests

## Inputs Required

Collect these before changing code:
- current parsing behavior in `src/modules/contextPanel/assistantCitationLinks.ts`
- current render/decorate invocation path in `src/modules/contextPanel/chat.ts`
- citation label formatting in `src/modules/contextPanel/paperAttribution.ts`
- citation-related types in `src/modules/contextPanel/types.ts`
- current tests in `test/assistantCitationLinks.test.ts` and nearby markdown/render tests

## Decision Checklist

1. Citation type split
- blockquote sibling citation
- inline/general citation

2. Match priority (strict order)
1. `citationId`
2. `citationKey`
3. exact normalized label
4. controlled fuzzy match (author+year threshold)

3. Click behavior
- quote citation -> page jump
- general citation -> open PDF

4. Ambiguity policy
- unresolved + low confidence -> do not link

5. Compatibility
- legacy outputs without machine IDs must still parse and match via fallback layers

## Implementation Playbook

1. Update parse model (`ExtractedCitationLabel`) for machine token support.
- Parse hidden machine tokens such as `[cid:p12-a34]`.
- Preserve human-visible citation label.

2. Enforce match-priority resolver.
- Ensure deterministic ID-based matching outranks all fuzzy paths.

3. Keep blockquote citation decorator stable.
- Preserve existing quote-linked interaction and page-resolution flow.

4. Add inline citation decoration pass.
- Detect/transform inline citation tokens into clickable citation elements.

5. Add dedicated general-paper open resolver.
- For non-quote citations, open target PDF without requiring quote page lookup.

6. Add telemetry/debug match-mode labels.
- Use modes such as: `cid`, `key`, `exact`, `fuzzy`, `none`.

7. Expand tests before declaring refactor complete.

## Test Requirements

Parsing:
- valid cid token
- cid + page suffix
- malformed token handling

Matching:
- cid wins over conflicting label
- fuzzy matching blocked under low-confidence thresholds

Behavior:
- quote citation click jumps to page
- general citation click opens paper PDF

Regression:
- duplicate author-year labels across multiple papers
- stale active-reader false-positive prevention

## Rollout And Risk Checks

- Validate no regressions for existing citation chip behavior.
- Verify unresolved citations stay plain/unlinked.
- Verify hidden machine tokens do not leak into visible UI by default.
- Confirm fallback behavior for legacy messages remains functional.

## Done Criteria

Task is complete only if:
- code changes satisfy AGENTS citation standards
- required tests are added/updated and pass
- change notes identify each failure mode and corresponding test
- behavior is deterministic for high-confidence paths and conservative for low-confidence paths
