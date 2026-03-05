# Citation Reliability Test Matrix

## Parsing

- `P1`: parse `(Author et al., 2024) [cid:p12-a34]`
- `P2`: parse `(Author et al., 2024) [cid:p12-a34], page 7`
- `P3`: parse legacy `(Author et al., 2024)`
- `P4`: reject malformed machine token `(Author et al., 2024) [cid:]`
- `P5`: reject non-standalone narrative citation in strict standalone mode

## Matching Priority

- `M1`: cid match beats conflicting citation label text
- `M2`: citationKey match when cid absent
- `M3`: exact normalized label match when cid/key absent
- `M4`: fuzzy author-year fallback only when threshold met
- `M5`: low-confidence fallback remains unlinked

## Behavior

- `B1`: quote-backed citation click jumps to resolved page
- `B2`: general/inline citation click opens cited PDF
- `B3`: explicit page label uses direct navigation path
- `B4`: no active reader hijack for unrelated open PDF

## Ambiguity

- `A1`: two papers with same author-year are disambiguated by cid
- `A2`: when unresolved ambiguity remains and confidence low, render no link

## Regression

- `R1`: existing citation chip render still works
- `R2`: legacy outputs (without cid) continue to parse/match via fallback
- `R3`: stale cache does not redirect to wrong paper/page

## Minimum Required Coverage For Citation PRs

- At least 1 parsing test (`P*`)
- At least 1 ambiguity test (`A*`)
- At least 1 malformed input test (`P4` or equivalent)
- At least 1 integration-style render/decorate behavior test (`B*` or `R1`)
