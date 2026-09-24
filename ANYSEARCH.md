# AnySearch integration: maintenance and validation

## Scope and current evidence

This native REST provider adds general search and bounded URL extraction to
the compatible in-plugin Agent. Tavily remains the default. It does not add
tools to WebChat, Codex App Server, web-sync, or other external runtimes, and
does not replace CrossRef or Semantic Scholar.

Implementation date: September 24, 2026. The technical acceptance baseline is
the reusable AnySearch integration guide, verified September 14, 2026; its
catalog snapshot was taken at `2026-09-14T10:58:57.2431842+08:00`.
Public protocol references are the official `anysearch-ai/anysearch-skill`
repository's REST CLI and AnySearch REST documentation.
The public REST catalog was refreshed on September 24, 2026 at 09:44:56 UTC
(`GET /v1/domains`: HTTP 200, business code 0). General search does not
require a vertical tag.
The REST CLI was source-checked for search/extract bodies, optional Bearer
authentication and response envelopes. The shared `doc_spec.md` describes a
different MCP contract, so do not mix its schemas or account-registration
instructions into this REST adapter. Treat format coverage as unverified
until measured on REST.

**Source implementation and offline tests are not live acceptance.** The
guide makes base integration mandatory and extensions nonblocking unless
separately promised. This implementation includes extraction as a bounded
extension; other vertical/batch/discovery features are not promised. No
model-driven Agent conversation, live extraction, valid-key service,
upstream merge, or published release verification is claimed here.
Synthetic-key tests establish header behavior, not validity of a real key.

**Native anonymous settings test passed on September 24, 2026.** The actual
plugin was installed through its native scaffold in Zotero 10.0.3 with a
fresh isolated profile. The normal preferences UI saved AnySearch with an
empty key, closed/reopened successfully, and its Test search button returned
three real results. A transparent observer delegated to the real native HTTP
implementation: one dispatch, HTTP 200, business code 0, and matching response/UI
request ID `d363dc89-9a7b-42dc-9173-7627a790d277`. See
`ANYSEARCH-LIVE-VALIDATION.json` for timestamps, exact request, source hashes,
rendered public results and limitations. Dispatch count is not packet count.

## Configuration and supported inputs

Use Preferences → llm-for-zotero → Agent → Web search to select AnySearch.
Leave the optional key blank to use anonymous requests. Changes save through
the existing preferences system; no adapter-writing, account creation or
connection-test request is necessary to save or enable the provider.

Preferences under `extensions.zotero.llmforzotero`:

| Setting             | Default / behavior                             |
| ------------------- | ---------------------------------------------- |
| `webAccessProvider` | `tavily`; `anysearch` selects the new provider |
| `anysearchApiKey`   | Empty; trimmed when saved; optional            |
| `tavilyApiKey`      | Existing independent setting, unchanged        |

There is no environment, model-key or cross-provider credential fallback.
The factory resolves saved settings for every invocation. The registered tool
schemas and validation follow the current provider; stale Tavily-only
arguments are rejected after switching rather than dropped. Unknown provider
preference values resolve to the documented Tavily default, not an AnySearch
success claim. Settings save/reload has both offline regression coverage and
actual native-window close/reopen evidence; process-restart durability was
not tested.

The explicit **Test search (sends a public query)** button saves the visible
optional key and sends `Zotero reference management` with `max_results: 3`
through the saved AnySearch selection. It displays count, titles, URLs and a
safe request ID. No model is involved. This consumes service quota and can
encounter the 402 behavior below; it does not run when preferences open/save.
The successful settings test is evidence for this normal settings entry,
**not** proof of Agent `web_search`, same-run citation delivery or `web_read`
live acceptance. Those still need separate runtime evidence.

| Tool         | AnySearch input                                                               | REST mapping                                                                     |
| ------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `web_search` | Nonblank `query` up to 2,000 characters; `maxResults` integer 1–10, default 5 | `POST /v1/search`, JSON `{query, max_results}`                                   |
| `web_read`   | `urls`, one to five public URLs returned by search in this run                | One `POST /v1/extract` with `{url}` per unique URL, at most two concurrent calls |

The target origin is `https://api.anysearch.com`. No vertical tag, region,
language, domain/date filter, search depth, topic, extraction query or chunk
parameter is exposed. Supplying unsupported tool fields fails validation.
Tavily retains its own depth, topic, filtering, focused extraction and credit
behavior.

Search results use `data.results`, requiring title, public URL and
content/snippet. A valid empty results array is a successful empty search;
invalid envelopes and failed requests are errors. Extraction requires the
returned normalized URL to equal the requested normalized URL, avoiding
accidental attribution of a different page.

Both transports check HTTP status; successful HTTP responses also require
business `code: 0`. Safe successful request IDs appear in the tool result.
Extraction returns a list of observed successful request IDs, not a fabricated
single batch ID. There is no usage endpoint integration: usage fields are
omitted and `getUsage()` explicitly reports unsupported rather than returning
zero credits.

## Extraction boundaries

- Same-run search provenance, stable citation IDs and read-only network-egress
  plans remain in the existing tools/run-source helpers.
- Input URLs use the existing public-HTTP(S) validator. Credential-bearing,
  localhost/private literals and non-web URLs are rejected. This is not a
  guarantee against server-side redirects or DNS rebinding at the remote
  extraction service.
- Duplicate URLs are coalesced. Results and failures retain input order.
  Already-started calls may finish after another call fails; access, quota or
  rate-limit errors stop queued extraction calls. No failed call is retried.
- HTML/XHTML, text, JSON and Markdown are the documented REST formats.
  PDF/Office/media are unsupported; common binary suffixes are rejected before
  dispatch. Unknown content types may still be rejected by the service.
- The service snapshot describes HTML/text truncation at 50,000 characters
  and possible oversize errors for JSON/Markdown. That server behavior has not
  been live-verified. The adapter separately bounds each returned content or
  snippet to 12,000 characters and sets `truncated: true` when applying that
  local limit. Absence of this flag is **not** proof of complete server text.
- Fetch stops reading and cancels responses above 1,048,576 received bytes.
  Native XHR rejects an excessive declared Content-Length and aborts at a
  progress event above that limit; event-delivery granularity can overshoot
  the threshold, so this is not a hard browser-heap bound. A final UTF-8 size
  check also rejects oversized text before JSON parsing.
- A per-URL failure remains explicit in `failedResults`; snippets are never
  substituted for extracted text. Cancellation aborts in-flight transport and
  prevents new queued reads.

## Credential safety and quota errors

An empty key means **no Authorization header**, not an empty Bearer token.
A provided key uses Bearer authentication only for AnySearch. Fetch disables
cookies and redirects. Native Zotero requests prefer a fresh
`HTTP.newCookieContext()` and dispose that context after the request settles.
Older runtimes use a fresh empty `CookieSandbox` when the modern API is absent.
Both paths explicitly set the channel's `LOAD_ANONYMOUS` flag before dispatch
and pass `anon: true` to suppress ambient cookies and cached HTTP authentication.
Missing or invalid isolation/anonymous-channel support fails closed. The
Zotero 10.0.3 live test observed the actual channel's fresh user-context ID and
anonymous flag, with no Authorization header. This is native dispatch/channel
evidence, not an independent packet capture.

The documented anonymous-quota 402 response may contain server-generated
credentials. Never adopt, log, display, snapshot, export or persist those
credentials. The default transport does not parse non-success HTTP bodies;
the adapter never inspects those error bodies even with an injected transport.
Business failures on HTTP 200 also discard messages, credentials and
unrecognized payloads. Error text is fixed; transport exceptions/causes are
not retained. Native body/debug logging and automatic retries are disabled;
HTTP redirects are disabled on both transports.

No automatic paid retry, paid account creation, top-up or credential adoption
is implemented. There is no automatic anonymous fallback after a rejected
supplied key and no fallback to Tavily. This integration needs no signup to
use its anonymous path; it does not impose a general policy against ordinary
free signup outside this feature.

A real first anonymous request can still encounter a server-side quota or
account-generation behavior. Review that boundary before authorizing a live
test, and record a quota failure honestly rather than asserting success.

## Implementation map

- `src/webAccess/anysearchClient.ts`: injectable REST adapter, sanitized
  transport, response normalization, limits and bounded extraction.
- `src/webAccess/prefs.ts`: separate provider/key settings.
- `src/webAccess/types.ts`: provider-neutral optional depth/topic/query/usage
  fields; unavailable metrics are not fabricated.
- `src/agent/tools/read/webAccessShared.ts`: provider factory and unchanged
  runtime exclusions.
- `src/agent/tools/read/webSearch.ts`, `webRead.ts`: provider-aware schemas,
  validation, trace labels, existing provenance and authorization.
- `src/modules/preferences/webAccessPanel.ts`, `preferenceScript.ts`,
  `addon/content/preferences.xhtml`, `addon/prefs.js`, `typings/prefs.d.ts`:
  native configuration wiring. `src/utils/i18n.ts` supplies Chinese UI copy.
- `src/webAccess/tavilyClient.ts`: retains the existing implementation and
  safety helpers; adds explicit required-field checks now that shared request
  types allow provider-specific omissions. No broad transport refactor.

The existing scaffold bundles `src/index.ts` and copies `addon` assets; adapter
registration is reachable through the normal tool factory. An initial local
3.9.9 XPI build passed and static inspection found the adapter, factory,
preferences and defaults. The package was rebuilt and inspected after review
fixes. The patched source was installed through the native test scaffold for
the successful preferences test above. That is a test-mode bundle, not proof
that the production XPI is included in an upstream release.

## Offline validation and remaining acceptance

Focused tests use injected transport or stubbed native HTTP/fetch, never real
service/model access:

Local check on September 24, 2026 after native compatibility fixes:
**72 focused tests passed**. TypeScript and focused ESLint checks passed.
The final production build, architecture and cycle checks passed. The rebuilt
3.9.9 XPI passed CRC/static inclusion checks (171 entries; 4,362,417 bytes;
SHA256 `317d5cac6ddbd2210cfe93226c91f545d2064160c9aeb5e25e31bd7c6084492c`).
That production package was checked separately from the installed native
test bundle. Offline results do not establish live behavior; the native
preferences proof above is separate. Neither proves a valid-key response or
model-driven Agent end-to-end success.

```sh
node node_modules/tsx/dist/cli.mjs node_modules/mocha/bin/mocha.js --require ./test/register.cjs test/anysearchClient.test.ts test/anysearchIntegration.test.ts test/tavilyClient.test.ts test/webAccessTools.test.ts test/webSourceAttribution.test.ts test/webSourceUiContract.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Do not substitute the full workflow/live suite for these commands: other
workflows can require a real runtime, credentials or network. Test logs and
environment details should be retained by the integrator without secrets.

Coverage includes exact bodies/headers, empty-key saves, saved factory routing,
provider switches, native cookie/logging controls, HTTP/business errors,
credential-bearing synthetic 402 payloads, no retry/adoption, cancellation,
timeout, invalid responses/URLs, extraction limits/partial failures,
same-run citations, runtime gating, schema changes and Chinese settings copy.

Acceptance evidence and remaining review:

- [x] Native provider registration, configuration and offline regression tests.
- [x] Actual plugin installation and settings save/close/reopen in Zotero.
- [x] Public catalog refresh before the authorized anonymous invocation.
- [x] Normal user-entry invocation through the installed preferences button,
      without model credentials or a direct standalone HTTP script.
- [x] Sanitized request, native dispatch count, HTTP/business status, safe
      request ID and corresponding results displayed at that normal entry.
- [ ] Model-driven Agent `web_search` and citation delivery tested live.
- [ ] Included `web_read` extraction extension tested live independently.
- [ ] Existing valid-key live behavior, if separately tested; synthetic
      header coverage must not be described as real credential validation.
- [ ] Upstream maintainer review/merge, release inclusion and any external
      programme acceptance. These remain separate from technical test results.

The normal settings-entry test does not imply those unchecked states. An
anonymous quota failure would demonstrate routing/error handling, not
successful result delivery.

## Full snapshot capability coverage

All 40 subdomain headings in the dated guide are listed. “Not implemented”
means not added by this integration. “Unverified” means no real-service proof.
Out-of-scope extensions are nonblocking, not automatically defects.
The snapshot describes 17 domains/40 subdomains, not 40 tested data sources;
its 161 parameter definitions are not hardcoded into this provider.

| Subdomain                   | Implementation                                            | Real-service status         | Acceptance scope |
| --------------------------- | --------------------------------------------------------- | --------------------------- | ---------------- |
| `general.general`           | General search implemented; explicit tag mode not exposed | Native settings test passed | Base             |
| `resource.image`            | Not implemented                                           | Unverified                  | Out of scope     |
| `social_media.social_media` | Not implemented                                           | Unverified                  | Out of scope     |
| `finance.fundamental`       | Not implemented                                           | Unverified                  | Out of scope     |
| `finance.news`              | Not implemented                                           | Unverified                  | Out of scope     |
| `finance.screen`            | Not implemented                                           | Unverified                  | Out of scope     |
| `finance.calendar`          | Not implemented                                           | Unverified                  | Out of scope     |
| `finance.macro`             | Not implemented                                           | Unverified                  | Out of scope     |
| `finance.quote`             | Not implemented                                           | Unverified                  | Out of scope     |
| `academic.preprint`         | Not implemented                                           | Unverified                  | Out of scope     |
| `academic.citation`         | Not implemented                                           | Unverified                  | Out of scope     |
| `academic.dataset`          | Not implemented                                           | Unverified                  | Out of scope     |
| `academic.search`           | Not implemented                                           | Unverified                  | Out of scope     |
| `academic.biomedical`       | Not implemented                                           | Unverified                  | Out of scope     |
| `legal.case`                | Not implemented                                           | Unverified                  | Out of scope     |
| `legal.statute`             | Not implemented                                           | Unverified                  | Out of scope     |
| `legal.legislation`         | Not implemented                                           | Unverified                  | Out of scope     |
| `health.drug`               | Not implemented                                           | Unverified                  | Out of scope     |
| `health.trial`              | Not implemented                                           | Unverified                  | Out of scope     |
| `health.stats`              | Not implemented                                           | Unverified                  | Out of scope     |
| `business.people`           | Not implemented                                           | Unverified                  | Out of scope     |
| `business.company`          | Not implemented                                           | Unverified                  | Out of scope     |
| `business.jobs`             | Not implemented                                           | Unverified                  | Out of scope     |
| `business.trade`            | Not implemented                                           | Unverified                  | Out of scope     |
| `security.scan`             | Not implemented                                           | Unverified                  | Out of scope     |
| `security.vuln`             | Not implemented                                           | Unverified                  | Out of scope     |
| `security.intel`            | Not implemented                                           | Unverified                  | Out of scope     |
| `security.noise`            | Not implemented                                           | Unverified                  | Out of scope     |
| `ip.global`                 | Not implemented                                           | Unverified                  | Out of scope     |
| `code.doc`                  | Not implemented                                           | Unverified                  | Out of scope     |
| `code.snippet`              | Not implemented                                           | Unverified                  | Out of scope     |
| `energy.electricity`        | Not implemented                                           | Unverified                  | Out of scope     |
| `energy.production`         | Not implemented                                           | Unverified                  | Out of scope     |
| `environment.aqi`           | Not implemented                                           | Unverified                  | Out of scope     |
| `agriculture.fao`           | Not implemented                                           | Unverified                  | Out of scope     |
| `travel.flight_status`      | Not implemented                                           | Unverified                  | Out of scope     |
| `travel.flight`             | Not implemented                                           | Unverified                  | Out of scope     |
| `film.torrent`              | Not implemented                                           | Unverified                  | Out of scope     |
| `gaming.esports`            | Not implemented                                           | Unverified                  | Out of scope     |
| `gaming.store`              | Not implemented                                           | Unverified                  | Out of scope     |

Catalog discovery, explicit vertical/source choice, parallel search and
region/language options remain unimplemented/out of scope. Bounded extraction
is implemented and offline-tested but real-service-unverified. Safe successful
request IDs are exposed in results; no dedicated diagnostics UI is promised.
Any future vertical must validate current required/conditional parameters and
source options, rather than infer support from a query mentioning a platform.
