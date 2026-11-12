# Provider balance and quota footer

Account allowance is independent of conversation context usage and locally recorded token totals.
The footer queries the selected provider and hides unavailable data, including authentication failures, unsupported endpoints, and malformed responses.
It displays the most-used applicable quota window, with individual windows, available reset times, and the last check in the tooltip.
Balances preserve the provider's currency; a limited key's allowance is labelled separately from an account balance.

## Supported sources

| Connection                    | Display                                   | Read contract                                                                                                                        |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| DeepSeek                      | Account balance in USD or CNY             | `GET https://api.deepseek.com/user/balance`; `balance_infos[].total_balance`                                                         |
| OpenRouter                    | Limited API key allowance in USD          | `GET https://openrouter.ai/api/v1/key`; `data.limit_remaining` when `data.limit` is finite                                           |
| Kimi / Moonshot China         | Available account balance in CNY          | `GET https://api.moonshot.cn/v1/users/me/balance`; `data.available_balance`                                                          |
| Kimi / Moonshot international | Available account balance in USD          | Same balance path on `api.moonshot.ai`; regional credentials remain separate                                                         |
| Kimi Code                     | Weekly and returned rolling-window usage  | `GET https://api.kimi.com/coding/v1/usages`; `usage` and `limits[].detail` counters                                                  |
| GLM / Z.ai Coding Plan        | Reported model quota usage                | `GET /api/monitor/usage/quota/limit` on `open.bigmodel.cn` or `api.z.ai`; `data.limits[]` with `type: TOKENS_LIMIT` and `percentage` |
| MiniMax ordinary API key      | Available account balance in USD or CNY   | `GET /account/query_balance` on the configured regional origin; `available_amount` for `sk-api-` keys                                |
| MiniMax Token Plan            | Applicable rolling and weekly quota usage | `GET /v1/token_plan/remains` on the configured regional origin; selected model's `model_remains[]` entry                             |
| OpenCode Go                   | Rolling, weekly, and monthly quota usage  | `GET https://opencode.ai/zen/go/v1/usage`; `usage.{rolling,weekly,monthly}.percent` with the existing Bearer API key                 |
| Codex app server              | Account quota usage                       | `account/rateLimits/read`, preferring the named Codex bucket                                                                         |
| Claude Code                   | Five-hour and seven-day account usage     | Companion bridge `GET /account-quota`, using the installed Agent SDK's structured usage control request                              |

GLM detection is limited to `/api/anthropic` and `/api/coding/paas/v4` routes, because prepaid inference and the Coding Plan have separate allowances.
GLM's tool/MCP allowance is excluded; window durations and reset times are omitted when their contract is not established.
Kimi Code converts explicit used or remaining counters into percentages only when a positive limit exists.
Missing usage is never treated as zero, and Kimi's available balance is never reconstructed from cash and voucher balances.

## MiniMax integration

MiniMax uses the endpoint selection in its official CLI: ordinary `sk-api-` keys read account balance, while other API keys read Token Plan allowance.
The allowed origins are international `api.minimax.io` (USD), China `api.minimax.cn` (CNY), and the legacy China origin `api.minimaxi.com` (CNY).
The request stays on the configured origin, including for the legacy host; a redirect or unavailable contract hides the indicator.
The response must report a successful `base_resp.status_code`.
Available balance is used directly, including zero or debt, without adding cash, vouchers, or credit again.

Plan selection prefers the exact selected model, then its longest matching provider wildcard, then the shared `general` bucket.
Unrelated media buckets are excluded, and the selected model is part of the cache key.
Explicit remaining percentages take precedence over count fields, whose meaning has changed between response versions.
Count-only legacy responses follow the official CLI's remaining-count interpretation.
Unlimited or unprovisioned windows and malformed counters are hidden.
Weekly boosts change the provider's displayed allowance ceiling; our percentage measures the used fraction of the full allowance, so the boost factor cancels.
Returned millisecond window boundaries supply durations and reset times when valid.

Validation covers regional request routing, both key types, model selection, old and new quota payloads, missing and malformed data, and the native Zotero footer with fixtures.
A live MiniMax account read has not been verified.

## OpenCode Go integration

Only Go inference routes under `https://opencode.ai/zen/go/v1` and `https://opencode.ai/inference/go/` select this quota source.
Zen prepaid routes on the same host remain unsupported because Go usage does not describe their balance.
The request reuses the configured API key, with no additional credential or settings field.
The footer displays the highest reported percentage and names rolling, weekly, and monthly periods in the tooltip.
Reset times come from the provider; durations are not inferred, including for calendar months.
Missing, invalid, unauthorized, and subscription-ineligible responses hide the indicator.
Valid individual windows remain usable when other windows are absent or malformed.

Validation covers route selection, provider payload parsing, Bearer authentication, a rejected subscription, and the native Zotero footer switching from Go to Zen.
A live OpenCode Go account read has not been verified.

## Claude Code integration

Claude Code requires the companion adapter change in `cc-llm4zotero-adapter` and a running bridge built from that source.
Older bridges return 404 and the indicator stays hidden.
The bridge uses `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` from Agent SDK 0.3.220, so the method is feature-detected and the payload is validated.
The probe reuses the chat's scoped working directory and configured settings sources to select the same account/provider configuration.
It submits no user message, disables hooks and MCP servers, disables session persistence, times out after eight seconds, and closes its SDK connection on every path.
Only normalized quota windows leave the bridge; session costs and model usage do not.
API-key and third-party Claude configurations may report that subscription limits do not apply, in which case the indicator stays hidden.

## Remaining preset feasibility

These connections currently keep the indicator hidden.
This assessment concerns provider-reported balance or account quota, not estimated spending or per-request token totals.
An unverified endpoint is a research limit, not proof that an integration is impossible.
GitHub Copilot is excluded from this assessment at the user's request.
Adding separate billing credentials for Grok and Qwen is deferred at the user's request.

| Connection                              | Feasibility                                                                                | Evidence and remaining requirement                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenCode Zen prepaid                    | No verified public API-key balance contract found                                          | [Zen documentation](https://opencode.ai/docs/en/zen/) describes prepaid credits; the reviewed server exposes billing information through authenticated console queries, separately from the Go quota route.                                                                                      |
| Grok / xAI                              | Feasible with extra credentials                                                            | The [prepaid balance endpoint](https://docs.x.ai/developers/rest-api-reference/management/billing) requires a team ID and a [Management API key](https://docs.x.ai/developers/rest-api-reference/management), separate from the inference key.                                                   |
| Qwen / DashScope                        | Feasible with extra credentials                                                            | Alibaba Cloud's [QueryAccountBalance](https://help.aliyun.com/en/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance) returns account balance and currency; it requires Cloud AccessKey authentication and billing permissions, separately from a DashScope model key. |
| OpenAI API                              | Usage and costs are available; no verified remaining-credit endpoint with the ordinary key | The official [Usage and Costs API example](https://developers.openai.com/cookbook/examples/completions_usage_api) uses an organization admin key; spending history alone does not establish remaining credit.                                                                                    |
| Anthropic API                           | Usage and costs are available; no verified remaining-credit endpoint                       | [Usage and Cost APIs](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) require organization-level credentials; workspace-scoped keys do not qualify, and these reports do not supply remaining credit. Claude Code subscription quota is handled separately above.              |
| Gemini                                  | No suitable public balance endpoint verified                                               | Current [billing documentation](https://ai.google.dev/gemini-api/docs/billing/) directs prepaid balance management to AI Studio; a Gemini model key does not establish access to Cloud Billing administration.                                                                                   |
| GLM prepaid API                         | No suitable public balance endpoint verified                                               | The documented [account system](https://docs.bigmodel.cn/cn/guide/platform/equity-explain) distinguishes cash and gift balances; the verified Coding Plan quota contract does not establish either prepaid balance.                                                                              |
| MiMo                                    | No suitable public balance or Token Plan quota endpoint verified                           | Official [payment guidance](https://mimo.mi.com/docs/en-US/quick-start/faq/payment) and [quota guidance](https://mimo.mi.com/docs/en-US/quick-start/faq/token-plan/Usage&Quota) direct users to the console's balance and plan usage pages.                                                      |
| Ollama / local OpenAI-compatible server | Not applicable to the local presets                                                        | Local inference has no common provider account balance; a separately hosted service would need its own verified contract.                                                                                                                                                                        |

SiliconFlow's former `/user/info` endpoint was retired on August 14, 2026; it is deliberately not queried.
OpenRouter account-wide credits require a management key, so ordinary unlimited keys do not display a made-up account balance.
Arbitrary custom endpoints are not probed for billing contracts.

## Refresh and credential boundaries

Reads are cached in memory for sixty seconds and shared across panels with the same target.
Completing a chat turn or clicking the displayed allowance refreshes the value.
Switching targets clears the previous display immediately, and late replies cannot replace the new target's data.
API credentials are sent only to allowlisted HTTPS origins matched against the configured API URL; preset names and model names do not establish that trust.
Requests reject redirects and omit browser cookies, with no fallback across regions or domains.
No balance, usage, or credential is persisted by the quota feature.

## Sources checked September 29, 2026

- [DeepSeek balance API](https://api-docs.deepseek.com/api/get-user-balance/).
- [OpenRouter current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) and [management-only account credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).
- [Kimi international balance](https://platform.kimi.ai/docs/api/balance) and [China balance](https://platform.kimi.com/docs/api/balance).
- [Moonshot's official Kimi Code usage implementation](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py).
- [Z.ai's official Coding Plan usage implementation](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs).
- [Codex app-server rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- [Claude statusline account windows](https://code.claude.com/docs/en/statusline), plus the installed Agent SDK 0.3.220 `Query` and `SDKControlGetUsageResponse` type declarations.
- [MiniMax Token Plan usage endpoint](https://platform.minimax.io/subscribe/token-plan).
- MiniMax official CLI at `06e47c70b76f419196678367dae62acca4c94076`: [endpoint and key routing](https://github.com/MiniMax-AI/cli/blob/06e47c70b76f419196678367dae62acca4c94076/src/client/endpoints.ts), [response contracts](https://github.com/MiniMax-AI/cli/blob/06e47c70b76f419196678367dae62acca4c94076/src/types/api.ts), [counter interpretation](https://github.com/MiniMax-AI/cli/blob/06e47c70b76f419196678367dae62acca4c94076/src/utils/quota.ts), [boost and unlimited display](https://github.com/MiniMax-AI/cli/blob/06e47c70b76f419196678367dae62acca4c94076/src/output/quota-table.ts), and [regional hosts](https://github.com/MiniMax-AI/cli/blob/06e47c70b76f419196678367dae62acca4c94076/src/config/schema.ts).
- MiniMax [China pricing in yuan](https://platform.minimax.cn/docs/guides/pricing-paygo) and [international USD payment terms](https://platform.minimax.io/protocol/terms-of-service).
- OpenCode official server at `7945de208964a49300d7f770d1a71d078db9a4c4`: [Go usage endpoint and authentication](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/console/app/src/routes/zen/go/v1/usage.ts) and [quota percentage calculation](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/console/core/src/subscription.ts).
- [SiliconFlow retirement notice](https://docs.siliconflow.cn/docs/release-notes/overview).
