# AGENTS.md

## Project Context

This repository is the Zotero plugin `llm-for-zotero`.

Citation system ownership paths:
- `src/modules/contextPanel/assistantCitationLinks.ts`
- `src/modules/contextPanel/chat.ts`
- `src/modules/contextPanel/paperAttribution.ts`
- `src/modules/contextPanel/types.ts`
- `test/assistantCitationLinks.test.ts`

## Skill Discovery

Project-local skills live under `skills/`.

Available skills:
- `citation-reliability`: plan + implement workflow for robust citation parsing, matching, link decoration, and navigation behavior.

## Trigger Rules

Agents must use the `citation-reliability` skill when requests mention any of:
- citation label, citation link, citation chip
- click to paper, click to page, jump to source
- author-year reference parsing or rendering
- ambiguity/disambiguation of citation targets
- citation robustness, stability, deterministic matching

## Non-Negotiable Citation Standards

- Prefer deterministic `citationId` matching first when available.
- Quote-backed citations must prioritize page jump behavior.
- General citations (not quote-backed) must open the cited PDF.
- Low-confidence matches must remain unlinked (never best-guess link).
- Backward compatibility is required for legacy outputs without machine IDs.

## Required Evidence Before Proposing Changes

Agents must:
- inspect current parser + decorator + resolver + tests
- list concrete failure mode addressed by each proposed change
- include regression tests for each failure mode

## Acceptance Gate

A citation-related change is not complete unless all are satisfied:
- unit tests updated
- at least one ambiguity test
- at least one malformed citation test
- at least one integration-style render/decorate test path

## Contribution Notes

- Keep user-facing citation text human-readable.
- Keep machine identifiers hidden by default in UI while preserving them in parser/DOM data attributes.
- Prefer deterministic behavior over maximum link coverage.
