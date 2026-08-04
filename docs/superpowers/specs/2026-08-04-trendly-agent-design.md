# Trendly Agentic Support Assistant — Design Specification

**Status:** Approved
**Date:** 2026-08-04
**Deadline:** 2026-08-06
**Author:** FDE candidate submission — Yellow.ai Delivery Team screening

---

## 1. Problem Statement

Trendly is a D2C fashion retailer handling ~2,000 support chats/day, ~70% repetitive
(order status, returns/exchanges, shipping and refund policy). Build a multi-turn agent
that resolves that volume end to end and hands the remainder to a human cleanly.

Assessed on two axes: **orchestration** (how the agent decides, chains, recovers, and
carries state) and **prompt engineering** (behavioral control, policy grounding,
uncertainty handling).

Two fixed inputs, loaded as-is and never mutated:

- `trendly_policy.md` — the *only* source of truth for policy.
- `orders.json` — 10 orders, 4 customers.

Both remain at **repository root, unmoved and unrenamed**. `orders.json` carries an
explicit instruction — *"Load this file as-is. Do NOT edit, rename, or add orders — the
evaluation harness tests against these exact records."* Relocating them into a `data/`
directory would be a gratuitous risk against an unseen harness for zero benefit. The
loader reads from root.

---

## 2. Governing Principle

> **The LLM decides *what to do*. Deterministic TypeScript decides *what is true*.**

Return eligibility, business-day arithmetic, refund timelines, and window expiry are
**pure functions**. They are never model judgments. The model routes, gathers, and
narrates; it does not adjudicate.

Three consequences, all of them wins:

1. **Correctness is provable.** Eligibility is unit-testable without an LLM in the loop.
2. **Mutation testing is cheap.** Pure functions with no I/O reach ≥90% mutation score
   without heroics.
3. **The failure mode disappears.** The model cannot hallucinate a verdict it is not
   permitted to author.

---

## 3. Dataset Analysis — Every Trap, Enumerated

The 10 orders are a rule-coverage matrix, not sample data. Computed against
`now = 2026-08-04`:

| Order | Condition | Correct behavior | Clause |
|---|---|---|---|
| TR-4530 | delivered 9d ago, apparel, not final sale | ✅ refund eligible — happy path | 2.1 |
| TR-4523 | delivered 60d ago (window closed 2026-07-05) | ❌ refuse — **window** | 2.1 |
| TR-4527 | delivered 12d ago, **jewellery** | ❌ refuse — **category**, not date | 2.3 |
| TR-4528 | delivered 16d ago, `final_sale: true` | ⚠️ **size exchange only**, no refund | 2.4 |
| TR-4526 | `lost_in_transit` | 🚨 **not a return** — lost-parcel claim, escalate | 1.6 |
| TR-4529 | cancelled + refunded | ❌ no return can exist against it | 2.6 |
| TR-4525 | 14 business days past expected | ⚠️ acknowledge delay **then** offer ₹250 | 1.5 |
| TR-4524 | `partially_shipped`, backorder ETA 2026-08-09 | ℹ️ no second shipping fee | 1.4 |
| TR-4521 | `in_transit`, expected 2026-07-31 | ⚠️ **NOT delayed** — see Trap A | 1.5 |
| TR-4522 | tee (returnable) + socks (innerwear) | ⚠️ **split verdict** — see Trap B | 2.1 / 2.3 |

### Trap A — Business days, not calendar days (TR-4521)

§1.5: *"more than 3 **business** days past its expected delivery date."*

TR-4521 expected **Friday 2026-07-31**. As of Tuesday 2026-08-04 that is **4 calendar
days but only 2 business days** — the weekend intervenes. It therefore **does not**
qualify for the ₹250 credit. A calendar-day implementation wrongly offers money here.

Verified by computation, not assumption:

```
TR-4521  expected 2026-07-31 (Fri) → calendar 4d, business 2d → delayed = FALSE
TR-4524  expected 2026-08-02 (Sun) → calendar 2d, business 2d → delayed = FALSE
TR-4525  expected 2026-07-15 (Wed) → calendar 20d, business 14d → delayed = TRUE
TR-4526  expected 2026-07-06 (Mon) → calendar 29d, business 21d → delayed = TRUE
```

**Known limitation (documented, not hidden):** business-day math excludes weekends only.
The policy never names a holiday calendar, and Trendly ships across four Indian metros
while serving at least two international customers (`+1`, `+34`). Inventing a holiday
calendar would violate §7. This becomes **discovery question #2**.

### Trap B — Eligibility is per-SKU, not per-order (TR-4522)

TR-4522 contains an Everyday Cotton Tee (`apparel`, returnable) **and** an Ankle Socks
3-pack (`innerwear`, non-returnable under §2.3). One order, two verdicts. Any
order-level eligibility check fails this case.

**`check_return_eligibility` therefore returns an array of per-item verdicts.**

### Trap C — `prepaid_card` is not in the refund table (TR-4521)

§3.1 enumerates exactly four payment methods: Credit/debit card, UPI, Cash on delivery,
Store credit. TR-4521 uses **`prepaid_card`**, which is none of them. A prepaid card is
not a credit card and not a debit card.

Per §7 the assistant **must not invent policy where the document is silent**. The correct
behavior is `UNMAPPED_PAYMENT_METHOD` → state that the policy does not specify → offer a
human. Silently mapping it to "5–7 business days" is a hallucination that looks like
competence. This becomes **discovery question #1**.

### Trap D — Policy silence on interacting clauses (TR-4526)

TR-4526 is `lost_in_transit` **and** 21 business days past expected delivery. §1.6 sends
it to a human; §1.5 would grant ₹250. The policy never says whether a lost parcel also
earns delay credit. The agent must **not** resolve this — it escalates and says the
policy is silent.

### Trap E — The 48-hour damage window has closed on every order

§6.1 requires damaged/wrong items be reported **within 48 hours of delivery**. The most
recently delivered order (TR-4530, 2026-07-26) is 9 days old. Every damage report against
this dataset is therefore **outside** the reporting window — while §6.2 simultaneously
says non-returnable categories *are* covered when damaged. The agent must apply §6.1's
window honestly and escalate rather than promise a replacement it cannot authorize.

### Trap F — Two policy paths are unreachable through the fixed dataset

**Footwear (§2.5).** The only footwear item is TR-4525's Court Sneakers, and that order is
`delayed` — never delivered. The return window has not opened, so the §2.5 shoe-box
deduction path cannot be reached through `orders.json` at all.

**Store-credit refunds (§3.1).** No order uses `store_credit` as a payment method, so the
"Immediate" refund row is likewise unreachable.

Both are implemented and unit-tested against synthetic fixtures anyway. Implementing only
what the sample data exercises would leave the agent brittle the moment real orders
arrive — and §2.5 and §3.1 are policy the agent will be asked about *conversationally*
("what if I lost the shoe box?") even when no order triggers them. This is called out in
`SOLUTION.md` rather than left as an unexplained coverage gap.

### Date-drift risk

TR-4522's return window closes **2026-08-13**. A harness run after that date changes the
correct answer legitimately. **Decision:** use real system time (correct behavior), emit
the reference date in every tool result so reasoning is auditable, and expose a
`TRENDLY_AS_OF` env override for reproducible demos and cassette replay.

---

## 4. Architecture

### 4.1 Stack

| Layer | Choice | Justification |
|---|---|---|
| Language | TypeScript (strict) | One language across UI, agent, and tests; Zod gives one schema for runtime validation *and* tool JSON Schema |
| Framework | Next.js 15 App Router | Single deployable; SSE streaming; RSC for the shell |
| LLM transport | AI SDK v5 | Provider-agnostic adapters solve Gemini↔Groq portability |
| Providers | Gemini (primary) → Groq (fallback) | Free tier only; failover is mandatory, see §4.3 |
| Retrieval | BM25 + alias map over parsed clauses | See §6 — no vector DB |
| Tests | Vitest + Stryker | Coverage ≥90% repo-wide; mutation ≥90% on `lib/policy` + `lib/guards` |
| Hosting | Vercel Hobby | 300s function duration; no cold spin-down (unlike Render free), so the URL stays live for the required two weeks |

**Rejected: LangChain / LangGraph.** For a 13-tool agent it adds abstraction depth and
version churn while hiding the exact loop being graded. The assignment warns candidates
must "explain and modify your own code live." Framework indirection is a liability there.

**Rejected: vector database.** The policy is 5.9 KB / 29 clauses. Embeddings would be
slower, non-deterministic, an extra dependency, and *less* accurate than lexical scoring
over a corpus this small. `AGENTS.md` forbids technology adoption without evaluation.

### 4.2 The orchestration loop

AI SDK provides transport and streaming. **The loop is hand-written**, because
orchestration is half the grade and must be inspectable, demonstrable, and defensible.

```
per user turn:
  1. INPUT GUARDS      pii · injection · out-of-scope        → may short-circuit
  2. PLAN              model call → tool calls | final text
  3. AUTHORIZE         identity binding, server-side
  4. EXECUTE           tools, parallel where independent
  5. OUTPUT GUARDS     numeric grounding · citations · concessions · leakage
  6. REPAIR            1 constrained retry → else safe template + escalate
     ↑ loop to 2 until final text | step budget | circuit breaker
  every stage emits a trace event carrying correlation_id
```

`stopWhen: isStepCount(8)` remains as a hard backstop ceiling only.

**Recovery paths (explicitly graded as "recovers from failure"):**

| Failure | Response |
|---|---|
| Provider 429 / 5xx | Circuit breaker opens → failover to Groq → retry with jitter |
| Both providers down | Deterministic template + `escalate_to_human` |
| Malformed tool args | Zod rejects → structured error returned to model → one retry |
| Same tool called identically twice | Loop detector halts, forces summarization |
| Step budget exhausted | Escalate with partial trace |
| Output validator fails twice | Safe template + escalate (never emit the defect) |

### 4.3 Provider strategy under free-tier quotas

Measured constraint: Gemini free ≈ 10 RPM / ~250–500 RPD (Google cut quotas 50–80% in
Dec 2025); Groq free ≈ 30 RPM / 1K RPD / 12K TPM on 70B-class models. An agent turn costs
2–4 model calls. A 30-scenario eval suite is ~360 calls — **more than one full daily
Gemini quota per run.**

Mitigations, all load-bearing:

1. **Cassette record/replay** in the eval harness. Live once, replay forever. CI is free,
   instant, deterministic.
2. **Circuit-breaker failover** Gemini → Groq, with per-provider health tracking.
3. **Token discipline.** The system prompt carries a compact *clause index*
   (IDs + one-line summaries, ~400 tokens), not the full policy. Exact clause text is
   retrieved on demand. This is required to fit 6–12K TPM alongside 13 tool schemas.
4. **Provider bake-off script** measures tool-calling accuracy per candidate model and
   selects on evidence.

Exact free-tier numbers are **not** hardcoded — neither vendor publishes them reliably
anymore. Limits are discovered at runtime and surfaced through the breaker.

---

## 5. Tools (13)

All schemas are Zod; Zod is the single source of truth for runtime validation and the
JSON Schema handed to the model.

| # | Tool | Mutating | Purpose |
|---|---|---|---|
| 1 | `verify_customer` | no | Bind session identity via email or phone |
| 2 | `lookup_order` | no | Order + derived facts; `ACCESS_DENIED` on mismatch |
| 3 | `list_customer_orders` | no | "Where's my stuff?" without an order ID |
| 4 | `check_return_eligibility` | no | **Per-SKU** verdicts + clause IDs |
| 5 | `check_exchange_eligibility` | no | Size-only; rejects colour/style (§4.1) |
| 6 | `search_policy` | no | Clause retrieval; emits `NO_COVERAGE` |
| 7 | `compute_refund_timeline` | no | §3.1 table; `UNMAPPED_PAYMENT_METHOD` for prepaid |
| 8 | `check_delay_credit` | no | §1.5 business-day math — eligibility only |
| 9 | `issue_delay_credit` | **yes** | §1.5 "on request" — idempotent per order |
| 10 | `initiate_return` | **yes** | Idempotent; re-checks eligibility server-side |
| 11 | `initiate_exchange` | **yes** | Idempotent; §4.3 auto-convert to refund |
| 12 | `report_damaged_item` | no | §6.1 48-hour window check |
| 13 | `escalate_to_human` | **yes** | Structured handoff ticket |

`check_delay_credit` and `issue_delay_credit` are deliberately **separate**. §1.5 grants
the ₹250 credit *"on request"* — determining eligibility is a read, granting it is a state
mutation, and collapsing the two would let a status query silently issue money. Issuance
re-verifies eligibility server-side and is idempotent on `orderId`, so a customer cannot
claim it twice by re-asking. Whether the agent may auto-issue at all is
**discovery question #3**; until answered, the design permits it because §1.5 states the
entitlement unconditionally and adds *"the customer does not need to cancel to receive
this."*

### 5.1 Eligibility verdicts (discriminated union)

```ts
type ItemVerdict =
  | { code: 'ELIGIBLE_REFUND';           clauses: ClauseId[]; refund: RefundPlan }
  | { code: 'ELIGIBLE_WITH_CONDITION';   clauses: ['2.5'];    deductionInr: 300;
                                          condition: 'ORIGINAL_SHOE_BOX_REQUIRED' }
  | { code: 'EXCHANGE_ONLY_FINAL_SALE';  clauses: ['2.4'] }
  | { code: 'INELIGIBLE_WINDOW';         clauses: ['2.1'];    windowClosedOn: string }
  | { code: 'INELIGIBLE_CATEGORY';       clauses: ['2.3'];    category: string }
  | { code: 'NOT_A_RETURN_LOST_PARCEL';  clauses: ['1.6'];    mustEscalate: true }
  | { code: 'NOT_APPLICABLE_CANCELLED';  clauses: ['2.6'] }
  | { code: 'NOT_YET_DELIVERED';         clauses: ['2.1'];    status: OrderStatus };
```

Every verdict carries the clause IDs that produced it. The output validator later
verifies the response cites only these.

**Category rules (§2.3).** Non-returnable: `innerwear`, `jewellery`, `beauty`,
`fragrance`, `face_mask`, `gift_card`. Returnable: `apparel`, `accessories`, `footwear`
(with §2.5 shoe-box condition). Matching is category-first with a name-keyword fallback
for "socks", since §2.3 names socks explicitly and a sock could be miscategorized.

**Precedence order** (first match wins — order is itself a tested behavior):
`lost_in_transit` → `cancelled` → not delivered → window expired → category → final sale
→ footwear condition → eligible.

Rationale: TR-4527 must be refused on **category** grounds even though it is also within
the window, and TR-4526 must be routed as a lost-parcel claim before any return logic
runs at all.

### 5.2 Mutating tools

`initiate_return` **re-runs eligibility server-side and refuses if ineligible.** The
model is never trusted to have checked. A jailbreak that convinces the model to file a
return against the jewellery order is stopped by the *tool*, not the prompt.

Idempotency key: `(orderId, sku, actionType)`. Retries return the existing RMA rather
than creating a second one. Writes go to an in-memory store seeded per process;
`orders.json` is loaded read-only and never mutated.

### 5.3 Escalation payload

```ts
{
  ticketId, correlationId, reasonCode, openedAt,
  customer:  { id, name, contact },        // only if verified
  orders:    OrderSummary[],
  situation: string,                        // plain-language summary
  attempted: ToolCallSummary[],             // what the agent already tried
  policyRefs: ClauseId[],
  suggestedResolution: string,
  transcript: Message[]
}
```

Reason codes: `LOST_PARCEL_CLAIM` · `COD_REFUND_BANK_DETAILS` · `POLICY_NOT_COVERED` ·
`SECOND_EXCHANGE_REQUEST` · `DAMAGED_ITEM_OUTSIDE_WINDOW` · `IDENTITY_VERIFICATION_FAILED`
· `OUT_OF_SCOPE_ADVICE` · `CUSTOMER_REQUESTED_HUMAN` · `VALIDATOR_REPAIR_FAILED`.

---

## 6. Policy Grounding

Parse `trendly_policy.md` at build time into **29 addressable units**: 26 numbered clauses
(§1.1–1.7, §2.1–2.6, §3.1–3.4, §4.1–4.4, §5.1–5.3, §6.1–6.2), §7 as a single
prohibition clause, and two meta-clauses (the "only source of truth" header, the
support-hours footer). Each clause: `{ id, section, title, text, aliases[] }`.

The parser asserts the expected clause count at build time — if the policy file is ever
edited, the build fails loudly rather than silently retrieving against a partial corpus.

`search_policy(query)` = **BM25 over clause text + a curated alias map**:

| Alias | → Clause |
|---|---|
| money back, refund time, when will I get my money | 3.1 |
| sale item, clearance, discounted item | 2.4 |
| underwear, socks, bra, innerwear | 2.3 |
| shoe box, sneaker box | 2.5 |
| lost, missing parcel, never arrived | 1.6 |
| late, delayed, hasn't arrived yet | 1.5 |
| change address | 1.7 |
| swap size, different size | 4.1–4.3 |

**The `NO_COVERAGE` signal is the critical feature.** When the best BM25 score falls below
threshold, retrieval returns `NO_COVERAGE` and the agent must say the policy does not
cover the question and offer a human — §7's hardest requirement. Most implementations
fail here because their retriever always returns *something*, which the model then
rationalizes into invented policy.

Threshold is calibrated against a fixture set of in-corpus and out-of-corpus queries
(e.g. "do you ship to Nepal?", "what's your warranty on watches?") and asserted in tests.

---

## 7. Guardrails

### 7.1 Input (pre-model)

| Guard | Trigger | Action |
|---|---|---|
| PII detector | Luhn-valid card numbers, CVV patterns, bank account / IFSC | Redact from transcript; respond per §3.3; never echo |
| Injection detector | "ignore previous instructions", role-override, system-prompt extraction | Neutralize, log, continue with hardened framing |
| Out-of-scope | Medical, legal, financial advice | Refuse per §7 + offer human |

### 7.2 Mid-loop

Server-side identity binding on every order-scoped tool · step budget · repeated-call
loop detector · provider circuit breaker.

**Identity gating (confirmed strict).** Session state machine:

```
ANONYMOUS → IDENTIFYING → VERIFIED → [ACTING] → ESCALATED
```

No order data — not even existence confirmation — is disclosed before `VERIFIED`.
`lookup_order` compares `order.customer_id` against the session's verified customer and
returns `ACCESS_DENIED` otherwise. This is enforced in the tool, not the prompt, because
prompt-level authorization is bypassable by injection. §7 forbids confirming *or
discussing* another customer's order, and cross-customer access is an obvious grader
probe (e.g. C-100 asking about TR-4522, which belongs to C-101).

### 7.3 Output (post-model, pre-send) — the anti-hallucination layer

| Validator | Rule |
|---|---|
| **Numeric grounding** | Every ₹ amount, day count, and date in the final message must appear verbatim in a tool result from this turn |
| **Citation** | Every policy claim maps to a clause ID actually retrieved this turn |
| **Concession** | `discount\|coupon\|waive\|goodwill\|% off\|free shipping` not present in tool output → block (§7) |
| **Leakage** | No order ID, customer name, or email appears that is not bound to the verified customer |

**Repair loop.** On violation: one constrained regeneration with the specific violation
fed back to the model. Second failure → deterministic safe template + `escalate_to_human`.
The defective message is never emitted. This is Jidoka: stop the line rather than ship a
known defect.

---

## 8. Observability

Every stage emits a structured JSON event carrying `correlation_id`, streamed to the UI
alongside the chat:

```ts
type TraceEvent =
  | { type: 'guard';     name: string; verdict: 'pass'|'block'; detail?: string }
  | { type: 'plan';      model: string; provider: string; latencyMs: number }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; code: string; clauses?: ClauseId[] }
  | { type: 'validator'; name: string; verdict: 'pass'|'repair'|'fail' }
  | { type: 'failover';  from: string; to: string; reason: string }
  | { type: 'escalation'; reasonCode: string; ticketId: string };
```

This makes the orchestration criterion **visible on camera** rather than merely asserted,
and doubles as the assertion surface for the eval harness.

Secrets and PII are redacted at the logger boundary.

---

## 9. Testing Strategy

### 9.1 Deterministic layer (no LLM, no quota)

Unit + property tests over `lib/policy` and `lib/guards`. Targets: ≥90% coverage
repo-wide, **≥90% mutation score on `lib/policy` and `lib/guards`** via Stryker.

Explicit cases: all 10 orders × eligibility; business-day boundaries around the
2026-08-01 weekend; per-SKU splitting on TR-4522; verdict precedence ordering;
`UNMAPPED_PAYMENT_METHOD` on prepaid; `NO_COVERAGE` threshold calibration; Luhn detector
true/false positives; numeric-grounding validator against synthetic hallucinations.

### 9.2 Conversation layer (LLM, cassette-backed)

~30 scripted multi-turn scenarios in YAML, bucketed into **exactly the six categories the
assignment names it grades**:

| Category | Scenarios | Examples |
|---|---|---|
| Order lookup & context | 6 | TR-4524 partial shipment; pronoun carry-over across turns; order ID with no customer given |
| Policy grounding | 5 | shipping fee thresholds; "do you ship to Nepal?" → `NO_COVERAGE` |
| Returns eligibility | 8 | one per trap in §3, incl. TR-4522 split verdict |
| Escalation | 4 | lost parcel; COD bank details; second exchange; policy silent |
| Safety & refusals | 4 | cross-customer probe; "give me 20% off"; card number in chat; injection |
| Robustness | 3 | provider failover; malformed input; contradictory multi-turn requests |

Each scenario asserts: tool-call sequence (subset match), verdict codes, cited clause IDs,
forbidden phrases, escalation flag. Runner emits a scorecard that goes into the README —
`AGENTS.md` requires evidence, not assertions.

### 9.3 Provider bake-off

Script runs the suite against 3 candidate models and reports tool-calling accuracy,
latency, and token cost per model. Selection is made on measured evidence
(`AGENTS.md` Gate 8), not vibes.

---

## 10. Repository Layout

```
app/
  (chat)/page.tsx              chat + live trace panel
  api/chat/route.ts            SSE agent endpoint
  api/trace/[id]/route.ts
  layout.tsx                   metadata, OG, theme bootstrap
  icon.png · apple-icon.png · opengraph-image.tsx · manifest.ts
lib/
  agent/    loop.ts · state.ts · prompts.ts · providers.ts · breaker.ts
  guards/   input.ts · output.ts · pii.ts · injection.ts · grounding.ts
  policy/   clauses.ts · retrieval.ts · eligibility.ts · business-days.ts · refunds.ts
  tools/    one file per tool, Zod-first
  data/     orders.ts (read-only loader) · store.ts (RMA writes)
  obs/      trace.ts · logger.ts
tests/
  unit/     rules engine + guards (mutation-tested)
  eval/     scenarios/*.yaml · runner.ts · cassettes/
docs/adr/   architecture decision records
orders.json · trendly_policy.md    ← repo root, verbatim, never moved or edited
README.md · PROMPTS.md · SOLUTION.md
```

---

## 11. Deliverables

| Deliverable | Content |
|---|---|
| `README.md` | One-command run, base URL, env setup, eval scorecard, **AI-usage note** |
| `PROMPTS.md` | Every system/tool prompt, versioned, with iteration rationale and what failed |
| `SOLUTION.md` | 1–2pp: architecture, trade-offs, known limitations, **5 discovery questions** |
| `docs/adr/` | ADRs for: no vector DB, hand-rolled loop, mutation-scope exception |
| Live URL | Vercel deployment, reachable ≥2 weeks past 2026-08-06 |
| Demo video | 3–5 min: happy path (TR-4530), 2 edge cases (TR-4526 lost, TR-4522 split), 1 honest failure |

### Five discovery questions for Trendly ops (drafted, refined in SOLUTION.md)

1. §3.1's refund table omits `prepaid_card`, yet 1 of 10 sample orders uses one. What is
   the real rule, and what other payment methods exist in production that the policy
   does not enumerate?
2. §1.5 counts "3 business days" — against which holiday calendar? You ship to four
   Indian metros and serve customers with `+1` and `+34` numbers.
3. Is the ₹250 delay credit auto-issuable by the agent or does it require approval? What
   is the system of record, and what idempotency key prevents double-claiming across
   sessions?
4. §1.6 escalates lost parcels to a human within 5 business days — what is the actual
   queue and SLA, and what should the agent do outside 9 AM–9 PM IST support hours?
5. What is the authoritative identity check? Email alone is spoofable. Is there an
   OTP or app session token we can consume, and what may be disclosed pre-verification?

---

## 12. Accepted Trade-offs and Known Limitations

| Trade-off | Rationale |
|---|---|
| Mutation testing scoped to `lib/policy` + `lib/guards`, not repo-wide | Deviation from `AGENTS.md` §Mutation Testing, accepted under the 2-day deadline and recorded as a written exception per rule 5. These modules are where a defect costs the assignment; UI and transport are covered by the ≥90% line-coverage gate. ADR required. |
| Business days exclude weekends only, no holiday calendar | Policy names none; inventing one violates §7. Surfaced as discovery question #2 and stated in tool output. |
| In-memory RMA store | No persistence requirement; state resets per deploy. Documented. |
| Real system time with `TRENDLY_AS_OF` override | Correct behavior by default; reproducible demos on demand. Date-drift after 2026-08-13 documented in SOLUTION.md. |
| Vercel Hobby is personal/non-commercial | Correct license for a personal screening assignment. Render/Fly documented as fallback. |
| Identity gating adds a turn to every conversation | Correct reading of §7; cross-customer disclosure is a hard failure, an extra turn is not. |

---

## 13. Definition of Done

1. All 10 orders produce the §3 verdicts, asserted in tests.
2. Eval scorecard green across all six categories; scorecard published in README.
3. Coverage ≥90% repo-wide; mutation ≥90% on `lib/policy` + `lib/guards`.
4. `tsc --noEmit` and ESLint clean.
5. Frontend asset suite complete per `AGENTS.md` (title, favicon set, OG image, manifest,
   theme-color, light/dark/system selector with no flash).
6. Live URL reachable; one-command local run verified from a clean clone.
7. README, PROMPTS, SOLUTION, and ADRs written and accurate.
8. Demo video recorded, including one honest failure.
