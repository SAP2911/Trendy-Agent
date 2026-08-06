# ADR 0004 — Provider selection by measurement

**Status:** Accepted · 2026-08-05 · Supersedes the plan's assumed defaults

## Context
Free tiers only. The plan named `gemini-2.5-flash` primary and `llama-3.3-70b-versatile`
fallback, chosen from training-data familiarity rather than measurement.

## Decision
**Primary: `openai/gpt-oss-120b` (Groq). Fallback: `gemini-3.6-flash` (Google).**

## Evidence
A live tool-calling probe against real keys, six candidates:

| Model | Result |
|---|---|
| `gemini-2.5-flash` | **DEAD** — "no longer available to new users" |
| `gemini-3.6-flash` | OK, 2945ms, single clean tool call |
| `gemini-3.5-flash` | OK, 21656ms — 7x slower |
| `moonshotai/kimi-k2-instruct-0905` | **DEAD** — no access |
| `llama-3.3-70b-versatile` | OK, 521ms, but issued a redundant double tool call |
| `openai/gpt-oss-120b` | OK, 910ms, single clean tool call |

Google was initially chosen primary on latency and quality. Live load testing then returned
HTTP 429 with `quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier`,
`quotaValue: "5"` — **five requests per minute**. An agent turn costs 2–5 model calls, so a
reviewer hitting the deployed URL would be rate-limited on their second message. Groq's
30 RPM makes it the only viable primary for a publicly reachable endpoint.

## Consequences
Both decisions inverted the plan, on measurement. The planned default would have hard-failed
on first run. Model IDs remain overridable via `TRENDLY_PRIMARY_MODEL` and
`TRENDLY_FALLBACK_MODEL`; the chain adapts to whichever keys are present.
