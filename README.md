# Trendly Support Assistant

An agentic customer-support assistant for Trendly, a D2C fashion retailer. It looks up
orders, answers policy questions grounded in the policy document, decides return and
exchange eligibility, acts on those decisions, escalates cleanly to a human, and refuses
what it must not do.

> **The LLM decides *what to do*. Deterministic TypeScript decides *what is true*.**
> Eligibility, business-day arithmetic and refund timelines are pure functions, never model
> judgments.

### 🔗 Live

**App:** <https://trendly-support-agent-kappa.vercel.app>
**Repo:** <https://github.com/SAP2911/Trendy-Agent>
**Demo video (3–5 min):** <https://www.loom.com/share/29ddbb9c89424946a499bd03759a6681>

---

**Architecture, trade-offs, limitations and discovery questions → [SOLUTION.md](SOLUTION.md)**
**Prompt engineering and its iteration log → [PROMPTS.md](PROMPTS.md)**

---

## Run it

```bash
git clone <this-repo>
cd trendly-support-agent
npm install
cp .env.example .env      # add at least one API key, see below
npm run dev               # http://localhost:3000
```

Both providers have a free tier and neither requires a card:

| Variable | Where to get it | Notes |
|---|---|---|
| `GROQ_API_KEY` | <https://console.groq.com/keys> | **Primary.** 30 RPM, ~0.9s per call |
| `GOOGLE_GENERATIVE_AI_API_KEY` | <https://aistudio.google.com/apikey> | Failover. Free tier is **5 RPM** |

Either key alone is enough — the provider chain adapts to whichever are present. Set both
to exercise circuit-breaker failover.

Optional: `TRENDLY_AS_OF=2026-08-04T12:00:00Z` freezes "today" for reproducible demos. Leave
it **unset in production**; real system time is the correct default.

### Commands

```bash
npm run dev            # dev server
npm run build          # production build
npm test               # 315 tests
npm run test:coverage  # tests + coverage gate (>=90% on lib/**)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run eval           # cassette-backed scripted-conversation harness, offline, no API key
npm run eval:record    # record fresh cassettes (needs GROQ_API_KEY; --record on PowerShell)
npm run mutation       # Stryker mutation testing over lib/policy/** and lib/guards/**
```

---

## Try these

Four one-click starter prompts are on the home page. Each exercises a different trap in the
fixed dataset:

| Prompt | What it demonstrates |
|---|---|
| `marcus.bell@example.com` — where is my order TR-4530? | Happy path: verify → look up → per-item eligibility → RMA |
| `priya.nair@example.com` — return the pearl earrings from TR-4527 | Refused on **category** (§2.3), not on dates — it *is* inside the window |
| `marcus.bell@example.com` — TR-4526 never arrived, I want to return it | Not a return. §1.6 lost-parcel claim → escalated to a human |
| `ananya.rao@example.com` — TR-4521 is late, give me 30% off | Refuses the discount, explains the business-day rule, offers nothing unauthorised |

Watch the **reasoning trace** on the right. Every guard verdict, tool call, result code,
policy citation and validator decision streams live. That panel is the orchestration story.

Try also: ask as `ananya.rao@example.com` about **TR-4522** (it belongs to another
customer) — you get the same response as for an order that does not exist. Or paste a card
number and watch it get refused before a single model call is made.

---

## How it works

```
INPUT GUARDS → PLAN → AUTHORIZE → EXECUTE → OUTPUT GUARDS → REPAIR
     ↑                                                          │
     └──────────── loop until final text / step budget ──────────┘
```

- **Input guards** — Luhn-validated card detection, injection heuristics, out-of-scope
  refusal. Can short-circuit with **zero** model calls.
- **Plan** — `streamText` (AI SDK 7) over 13 Zod-typed tools. `prepareStep` gates
  `activeTools` by session state, so an unverified session cannot even *see* the order
  tools.
- **Authorize** — tools read the verified customer from `runtimeContext`, never from a
  model argument. The model cannot forge a value it never supplies.
- **Execute** — tools call a deterministic policy engine that returns structured verdicts
  carrying the policy clause IDs that produced them.
- **Output guards** — every ₹ amount, day count and date in the reply must appear in a tool
  result from the same turn. Plus citation, concession and cross-customer-leak checks.
- **Repair** — one constrained retry with the violation fed back; a second failure returns a
  safe template and escalates. A known-defective message is never emitted.

### Layout

```
lib/policy/   clock · business-days · clauses · retrieval · eligibility · refunds · delay
lib/data/     read-only order loader · idempotent RMA/credit/ticket store
lib/tools/    13 Zod-typed tools (9 read, 4 mutating)
lib/guards/   pii · injection · input · grounding · output
lib/agent/    session · providers+breaker · prompts · loop
lib/obs/      structured trace with correlation ids
app/          SSE endpoint · chat UI · trace panel · asset suite
tests/unit/   315 tests (298 lib/agent+guards+policy+data + 17 eval-scenario schema)
tests/eval/   12 scripted conversation scenarios, cassette-backed offline harness
```

---

## Verification

| Gate | Result |
|---|---|
| Tests | **315 passing** (298 + 17 new eval-scenario schema tests) |
| Coverage (`lib/**`) | **99.71%** stmts · 96.9% branch · 100% funcs |
| Typecheck | clean (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Lint | clean |
| Build | clean |
| Mutation (`lib/policy/**`, `lib/guards/**`) | see [mutation testing](#mutation-testing) below |

All ten orders were verified against their designed verdicts by executing the real modules,
and the four graded scenarios above were verified end to end against a live provider.

**The fixed dataset is protected by a SHA-256 tripwire.** `orders.json` and
`trendly_policy.md` are asserted byte-identical on every test run; if either is edited the
suite fails loudly. They were never modified.

---

## Eval harness

`tests/eval/` is a cassette-backed scripted-conversation harness: 12 scenarios across the
six graded categories (order lookup, policy grounding, returns eligibility, escalation,
safety & refusals, robustness), each asserting on tool calls, tool result codes, cited
policy clauses, forbidden text patterns, and escalation — run entirely offline, by default.

```bash
npm run eval                                    # REPLAY — zero network calls, no API key needed
npm run eval:record                              # RECORD (POSIX) — needs GROQ_API_KEY
npx tsx tests/eval/runner.ts --record            # RECORD (PowerShell-safe CLI flag equivalent)
npx tsx tests/eval/runner.ts --record --only=id  # re-record one scenario
```

The cassette layer is a `LanguageModel` middleware (`ai@7.0.51`'s own `wrapLanguageModel` +
`LanguageModelV4Middleware`, not a hand-rolled model) keyed on a stable hash of model id,
instructions, messages and tool names. In replay mode a cassette miss **fails loudly**
(scenario name + request hash + a preview of what was actually asked) — it never silently
falls through to the network. Cassettes are committed JSON under `tests/eval/cassettes/`.
`tests/unit/eval-scenarios.test.ts` Zod-validates every scenario file on every `npm test`
run, with no cassette or network involved.

**Recording status: 1 of 12 scenarios has a usable cassette.** Recording is against Groq
only (no Gemini calls), strictly sequential, with a 3-second pause before every turn, and a
hard stop — never a retry — on the first provider failure. The one live recording attempt
made for this harness hit Groq's **daily token quota** on the very first scenario (`Used
199850/200000 TPD`, i.e. already exhausted before this attempt from other same-day use) —
confirmed by a real `429` from the API, not a guess. Per that stop condition, no further
scenarios were attempted. The partial capture for `order-lookup-status` (2 of its 3
model interactions, before the 429) is committed as evidence the record path works against
the live API; it is marked `incomplete` and is therefore never used for a passing replay.
`npm run eval` genuinely runs offline with zero network calls either way — it currently
scores `1/12` (the zero-model-call card-number refusal, which costs no quota to record or
replay) rather than `12/12`, honestly reflecting what has and hasn't been recorded yet. Full
scorecard and the exact reproduction commands are in
`.superpowers/sdd/2026-08-04-trendly-agent/eval-mutation-report.md`.

---

## Mutation testing

`stryker.config.json` runs Stryker over `lib/policy/**` and `lib/guards/**` (the highest
value targets: the policy engine and the guards) with the Vitest runner, `break: 90`. See
the report for the mutation score, the surviving-mutant list, and what was done about each.

```bash
npm run mutation
```

---

## AI usage

Built with Claude Code, working from a written design spec and a phase-by-phase
implementation plan (both in [`docs/design/`](docs/design/)).

**What I owned — the decisions the code is shaped by:**

- The governing split: deterministic TypeScript decides *what is true*, the LLM only
  decides *what to do*. Everything else follows from that.
- Reading the dataset as a rule-coverage matrix and identifying the six traps in it —
  including per-SKU eligibility, business-day vs calendar-day arithmetic, and
  `prepaid_card` being absent from the refund table.
- Three-layer identity gating, and the decision to read identity from `runtimeContext`
  rather than a tool argument so the model cannot forge it.
- Rejecting a vector database for a 29-clause corpus, and making `NO_COVERAGE` the
  load-bearing feature of retrieval rather than ranking.
- Hand-writing the orchestration loop instead of using the SDK's, because orchestration
  is the graded artifact.
- Scope and trade-off calls under deadline, recorded in [`docs/adr/`](docs/adr/).

**What AI generated:** the large majority of implementation code and tests, written
against task briefs derived from the plan and reviewed task by task.

**What I corrected during the build.** These are the parts a plan gets wrong, and each
was caught by measuring rather than trusting:

- `@types/react-dom@19.2.8` does not exist — DefinitelyTyped versions independently of
  React, so the pinned version was fiction.
- `gemini-2.5-flash` returns *"no longer available to new users."* It was the planned
  default and would have hard-failed on first run.
- Gemini's free tier is **5 requests per minute**. An agent turn costs 2–5 model calls,
  so a reviewer would have been rate-limited on their second message. Provider order was
  inverted to put Groq first after live load testing returned HTTP 429.
- AI SDK 7 renamed `system:` → `instructions:`, `fullStream` → `stream`, and
  `stepCountIs` → `isStepCount`; it also reports provider failure as an error *stream
  part* rather than throwing, which the failover path had to be written against.
- A test asserting TR-4521 was not owed delay credit passed on 4 August and failed on the
  6th, because the order genuinely crossed from 2 to 4 business days late. The
  implementation was right; the unpinned clock in the test was the bug.
- The agent answered *"what is 2+2?"* and *"who is Modi?"*. My out-of-scope guard covered
  only the three categories §7 names and missed the intent. Fixed with an explicit scope
  boundary and verified live.

I can walk through and modify any of this code — `lib/policy/eligibility.ts`,
`lib/agent/loop.ts` and `lib/guards/output.ts` are the ones worth asking about.
