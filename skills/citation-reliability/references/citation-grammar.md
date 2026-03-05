# Citation Grammar Reference

This file defines the citation parsing contract for robust linking.

## Goals

- Keep visible citation text human-readable.
- Support hidden deterministic machine tokens.
- Preserve backward compatibility with legacy human-only citations.

## Preferred Canonical Forms

1. General citation with machine token:
- `(Author et al., 2024) [cid:p12-a34]`

2. Quote citation with page and machine token:
- `(Author et al., 2024) [cid:p12-a34], page 7`

3. Backward-compatible citation key form:
- `(Author et al., 2024) [smith2024a]`

4. Legacy human-only form:
- `(Author et al., 2024)`

## Parsing Notes

- `cid` token format: `[cid:<id>]` where `<id>` is an opaque stable identifier.
- Page suffix format: optional `, page <number-or-label>`.
- Parser should tolerate surrounding whitespace and optional trailing period.
- Parser must reject non-standalone labels inside narrative sentence text unless inline parser mode is explicitly used.

## Matching Priority

Apply in this strict order:
1. `citationId` from cid token
2. `citationKey`
3. exact normalized source/citation label
4. controlled fuzzy (author surname + year)

## Safety Constraints

- If confidence is low after fallback matching, do not create clickable link.
- Never override a valid deterministic match with fuzzy output.
- Keep machine token hidden in rendered UI by default.
