# Trendly Support Assistant — Solution Note

## The governing idea

> **The LLM decides *what to do*. Deterministic TypeScript decides *what is true*.**

Return eligibility, business-day arithmetic, refund timelines and window expiry are pure
functions. They are never model judgments. The model's job is to route, gather, and
narrate; it does not adjudicate.

That one decision drives everything else. It means eligibility is provable without an LLM
in the loop, that a jailbreak cannot talk the system into a refund it should not give, and
that "no hallucinations" is enforced mechanically rather than requested politely.

---

## Architecture

```
 user turn
    │
    ▼
┌─────────────────┐   PII (Luhn-validated) · injection · out-of-scope
│ 1. INPUT GUARDS │   may short-circuit with ZERO model calls
└─────────────────┘
    │
    ▼
┌─────────────────┐   streamText (AI SDK 7) → tool calls or final text
│ 2. PLAN         │   prepareStep gates activeTools by session state
└─────────────────┘
    │
    ▼
┌─────────────────┐   identity read from runtimeContext, never from model args
│ 3. AUTHORIZE    │
└─────────────────┘
    │
    ▼
┌─────────────────┐   13 Zod-typed tools over a deterministic policy engine
│ 4. EXECUTE      │
└─────────────────┘
    │
    ▼
┌─────────────────┐   numeric grounding · citations · concessions · leakage
│ 5. OUTPUT GUARDS│
└─────────────────┘
    │
    ▼
┌─────────────────┐   ONE constrained retry → else safe template + escalate
│ 6. REPAIR       │
└─────────────────┘
    │  loop 2–6 until final text · step budget · circuit breaker
    ▼
 streamed reply + live trace (every stage carries correlation_id)
```

**Stack.** TypeScript (strict) · Next.js 16.3.0 · React 19.2.8 · AI SDK `ai@7.0.51` ·
Groq `openai/gpt-oss-120b` primary, Google `gemini-3.6-flash` failover · Zod 4 ·
Vitest 4. 291 tests, 99.71% statement coverage on `lib/**`.

**The loop is hand-written.** AI SDK 7 ships an agent loop; this project deliberately does
not use it. Orchestration is half of what the assignment assesses, and a loop hidden
behind `stopWhen: isStepCount(8)` leaves nothing to demonstrate or defend. Owning the loop
buys explicit control over guard placement, trace emission, repair, and failover.
`isStepCount` remains only as a backstop ceiling.

**No vector database.** The policy is 5.9 KB / 29 clauses. Retrieval is BM25 over parsed
clauses plus a curated alias map. Embeddings would be slower, non-deterministic, an extra
dependency, and *less* accurate at this size. The load-bearing feature is not ranking — it
is the `NO_COVERAGE` signal, which is how §7 ("never invent policy where the document is
silent") gets enforced. A retriever that always returns *something* hands the model
material to rationalise an answer from; that is the most likely path to invented policy.

---

## What the dataset actually tests, and what it caught

The ten orders are a rule-coverage matrix, not sample data. Six traps, all verified
against the running system:

| Trap | Why it breaks naive implementations |
|---|---|
| **TR-4521 business days** | 4 calendar days past expected but only **2 business days** — a weekend intervenes. §1.5 requires *more than 3 business days*. Calendar-day math hands this customer ₹250 they are not owed. |
| **TR-4522 mixed order** | One order holds a returnable tee **and** non-returnable socks. Eligibility must be computed **per SKU**; order-level logic returns one wrong verdict. |
| **TR-4527 category, not date** | Inside the 30-day window, but jewellery. Must be refused citing **§2.3 only**. Citing §2.1 would misstate the reason to the customer. |
| **TR-4526 lost ≠ return** | §1.6 makes this a lost-parcel claim handled by a human, not a return. The eligibility engine routes it away from the return flow entirely. |
| **`prepaid_card`** | §3.1 enumerates exactly four payment methods. TR-4521 uses a fifth. A prepaid card is not a credit card, so this returns `UNMAPPED_PAYMENT_METHOD` rather than a plausible guess. |
| **§2.5 / §3.1 dead paths** | No delivered footwear and no store-credit order exist, so those policy branches are unreachable from the sample data. Both are implemented and tested against synthetic fixtures anyway — customers ask "what if I lost the shoe box?" regardless of their order history. |

Answer-key fields (`_note_for_designers`, present on 7 of 10 orders and stating the
correct verdict outright) are **stripped at load**. Letting them reach the model would make
the agent look correct while proving nothing, and it would collapse on any scenario whose
answer was not pre-written into the data.

---

## Guardrails

**Identity gating is three independent layers**, because prompt-level authorization is
bypassable by injection:

1. **Exposure** — `prepareStep` sets `activeTools`. An unverified session is shown only
   `verify_customer`, `search_policy`, `escalate_to_human`. The order tools are not in its
   schema at all.
2. **Execution** — tools read the verified customer from `runtimeContext`, never from a
   model-supplied argument. *The model cannot forge a value it never supplies.*
3. **Emission** — the leakage validator scans the final message for any order ID not bound
   to the verified customer.

A missing order and another customer's order return **byte-identical responses**. If they
differed, the agent would be an order-existence oracle.

**Mutating tools re-verify server-side.** `initiate_return` recomputes eligibility itself
and refuses if ineligible. The model is never trusted to have checked — it may have been
persuaded, confused, or injected into. A jailbreak that convinces the model to file a
return against the jewellery order is stopped by the *tool*.

**Output validation is the anti-hallucination hammer.** Every ₹ amount, day count and date
in the final message must appear in a tool result from the same turn. Verified: 4/4 honest
sentences pass, 6/6 invented ones blocked. On violation the loop retries **once** with the
specific violation fed back; a second failure returns a deterministic safe template and
escalates. A known-defective message is never emitted.

---

## Key trade-offs

| Decision | Rationale |
|---|---|
| Hand-written loop over the SDK's | Orchestration is the graded artifact; framework indirection is a liability in a live code walkthrough |
| BM25 over embeddings | 29 clauses; determinism and testability beat semantic recall at this size |
| Groq primary, Gemini failover | **Measured, not assumed** — see below |
| In-memory RMA store | No persistence requirement; state is per-process and resets on deploy |
| Mutation testing scoped, then cut | Time-boxed; the ≥90% line-coverage gate on `lib/**` was held instead |
| Coverage gate on `lib/**` only | Business logic is unit-tested; UI is verified through the running stack |

**The provider decision inverted on evidence.** The plan named `gemini-2.5-flash` as
primary. A live probe showed it returns *"no longer available to new users"* on a freshly
issued key — it would have hard-failed on first run. Measuring six candidates gave
`gemini-3.6-flash` (2.9s) and `openai/gpt-oss-120b` (0.9s) as the working pair. Then live
load testing hit HTTP 429 on Gemini with `quotaValue: "5"` — **five requests per minute**
on the free tier. An agent turn costs 2–5 model calls, so a grader would be rate-limited on
their second message. Groq at 30 RPM became primary. Neither decision survived contact
with measurement, which is exactly why the plan deferred them to it.

---

## Known limitations

1. **Business days exclude weekends only.** The policy names no holiday calendar. Trendly
   ships to four Indian metros and serves customers with `+1` and `+34` numbers. Inventing
   a calendar would violate §7. → **Discovery question 2.**
2. **Verdicts drift with real time.** This is not theoretical — it happened during
   development. A test asserting TR-4521 was not owed delay credit failed two days later,
   because the order genuinely crossed from 2 to 4 business days late. The implementation
   was right; the unpinned assertion was the bug. The suite now pins `TRENDLY_AS_OF`, and a
   test asserts the *opposite* verdict at the later date so the boundary is covered rather
   than avoided. TR-4522's return window closes **2026-08-13**; runs after that date will
   legitimately produce different answers.
3. **Retrieval is silent on two realistic phrasings.** "how fast is delivery" (§1.2) and
   "my jeans don't fit" (§4.1) return `NO_COVERAGE`. Both fail in the **safe** direction —
   the agent offers a human rather than inventing — but they are less helpful than ideal.
   Fix is a two-line alias addition.
4. **§4.4 second-exchange approval is not auto-detected.** The idempotency key cannot
   distinguish a genuine second request from a retry. Not exercised by the fixed dataset.
5. **Concession detection uses a fixed vocabulary.** A novel euphemism for an offer would
   not trip it directly, though an invented figure would still be caught by numeric
   grounding.
6. **No persistence.** RMAs, credits and tickets live in process memory.
7. **Topical scope is enforced by prompt, not by tool.** The agent refuses general
   knowledge, maths, politics and coding requests (verified live), but this is the one
   guardrail without a deterministic backstop. A topic classifier was rejected because
   its false-positive risk against phrasings like "who is my delivery agent?" exceeds
   the residual risk it removes. This gap was found by the user in manual testing, not
   by my tests — worth stating plainly.

---

## Five discovery questions for Trendly ops

1. **§3.1 omits `prepaid_card`, yet 1 of 10 sample orders uses one.** What is the actual
   refund rule, and what other payment methods exist in production that the policy does not
   enumerate? Right now the assistant correctly refuses to guess — which is safe, and also
   a support ticket every time it happens.

2. **§1.5 counts "3 business days" against which holiday calendar?** Weekends alone are
   almost certainly wrong for a retailer shipping across India during Diwali, and the
   customer base is not India-only. Getting this wrong means either paying credits that
   are not owed, or refusing ones that are.

3. **Is the ₹250 delay credit auto-issuable by the assistant, or does it need human
   approval?** What is the system of record, and what idempotency key prevents a customer
   claiming it twice across separate chat sessions? Today it is keyed on order ID in
   process memory, which will not survive a real deployment.

4. **§1.6 promises lost-parcel resolution "within 5 business days" — what is the actual
   queue and SLA behind that?** And what should the assistant do outside the stated
   9 AM–9 PM IST support hours: promise a callback, or hold the ticket silently?

5. **What is the authoritative identity check?** Email alone is trivially spoofable, and
   §7 makes cross-customer disclosure a hard failure. Is there an OTP or an app session
   token the assistant can consume, and what may be disclosed *before* verification —
   currently the answer is "nothing at all", which is safe but adds a turn to every
   conversation.

---

## What I would do next, in priority order

1. Replace the in-memory store with a real one, keyed for idempotency across sessions.
2. Close the two retrieval gaps and add an alias-coverage test over realistic phrasings.
3. Restore the mutation-testing gate on `lib/policy` and `lib/guards`.
4. Add a cassette-backed eval harness so the scripted conversations run offline and free,
   which the free-tier rate limits otherwise make impractical to run often.
