# OmniCode AI Usage and Cost

Last updated: 2026-09-24

## Architecture

All provider calls converge on `AIManager`. Its shared invocation wrapper checks
configured budgets before a cloud request, optionally asks for confirmation for
a large estimated request, records the provider's returned usage metadata after
success, and records bounded failure metadata after an error. Code chat,
autocomplete, inline edit, Work Agent, Code Agent, and Omni all pass a normalized
mode/feature context through this boundary.

`AIUsageManager` stores versioned records in `ai-usage.sqlite` under Electron's
private `userData` directory. SQLite writes are parameterized and the database
file is created mode `0600` where supported. The renderer can access only typed
summary, settings, estimate, export, pricing, and destructive-delete IPC calls.
It has no database or filesystem path access.

Stored fields are limited to:

- timestamp, provider, model, mode, feature, and usage type;
- opaque conversation/project/agent/task identifiers;
- provider-reported input, output, cache, reasoning, and total token counts;
- estimated cost components, pricing status/version/source, latency, success,
  bounded error class, local/cloud classification, and bounded rate-limit state.

Prompts, responses, selected code, file contents, API keys, OAuth tokens,
authorization headers, cookies, and tool-result content are never part of the
usage record or export schema.

## Provider metadata

- OpenAI: chat-completions `usage`, cached input details, reasoning-token
  details, and supported rate-limit headers. Streaming requests explicitly ask
  for usage metadata.
- Anthropic: message/message-delta usage, cache-read tokens, cache-creation
  tokens, and supported rate-limit headers.
- Google Gemini: `usageMetadata`, cached-content tokens, thought tokens, and
  supported rate-limit headers.
- Ollama: `prompt_eval_count` and `eval_count` from final chat records. Local
  model API cost is always shown as `$0`; unknown token counters remain
  unavailable rather than estimated.

## Pricing and estimates

The versioned catalog is in `ai-pricing-catalog.ts`. It includes only narrowly
matched standard text models with prices verified against provider-owned pages:

- OpenAI: <https://developers.openai.com/api/docs/pricing>
- Anthropic: <https://platform.claude.com/docs/en/models/overview>
- Gemini: <https://ai.google.dev/gemini-api/docs/pricing>

Unknown models are unpriced. OmniCode never silently reuses a nearby family or
old price. Cost values are estimates in USD and every dashboard/export surface
states that provider billing is authoritative. The bundled catalog has an
explicit version/date and must be reviewed for each release.

## Dashboard and controls

Settings → AI Usage & Cost provides Today, 7-day, 30-day, current-month, and
custom ranges; provider and mode filters; cost/token/request charts; local vs
cloud totals; provider/model/mode/feature breakdowns; request metadata; daily,
weekly, and monthly budgets; large-request warnings; opt-in hard enforcement;
30/90/365-day or forever retention; CSV/JSON export; and native-confirmed
history deletion.

Warnings are advisory estimates. Hard enforcement happens in the main process,
before provider network access. Ollama remains usable when a cloud budget is
reached. When a configured hard budget cannot be evaluated because current
cloud usage or the requested model is unpriced, OmniCode fails closed and
explains why.

## Limits

- Tracking starts with OmniCode 0.9.0; historical provider-console usage is not
  imported.
- Provider dashboards can include activity from other apps and are the billing
  source of truth.
- Current text APIs return token usage but not a universally reliable billed-
  dollars field, so OmniCode calculates estimates from the versioned catalog.
- Live success for a provider still requires the user's valid credential,
  quota, service availability, and selected model access.

