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
npm test               # 291 tests
npm run test:coverage  # tests + coverage gate (>=90% on lib/**)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
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
tests/unit/   291 tests
```

---

## Verification

| Gate | Result |
|---|---|
| Tests | **291 passing** |
| Coverage (`lib/**`) | **99.71%** stmts · 96.9% branch · 100% funcs |
| Typecheck | clean (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Lint | clean |
| Build | clean |

All ten orders were verified against their designed verdicts by executing the real modules,
and the four graded scenarios above were verified end to end against a live provider.

**The fixed dataset is protected by a SHA-256 tripwire.** `orders.json` and
`trendly_policy.md` are asserted byte-identical on every test run; if either is edited the
suite fails loudly. They were never modified.

---

## AI usage

This project was built with Claude Code, working from a written design spec and a
phase-by-phase implementation plan (both in [`docs/superpowers/`](docs/superpowers/)).

**Generated by AI:** the large majority of implementation code and tests, written against
task briefs derived from the plan and reviewed task-by-task.

**Human/architectural direction:** the governing "deterministic core, LLM orchestrator"
decision; the dataset trap analysis; the three-layer identity design; rejecting a vector
database; hand-writing the loop rather than using the SDK's; scope calls under deadline.

**Corrected during the build** — worth recording, because these are the parts a plan gets
wrong:

- `@types/react-dom@19.2.8` does not exist; DefinitelyTyped versions independently.
- `gemini-2.5-flash` returns *"no longer available to new users"* — it was the planned
  default and would have hard-failed on first run.
- Gemini's free tier is **5 requests per minute**, so the provider order was inverted to
  put Groq first after live load testing produced HTTP 429.
- AI SDK 7 renamed `system:` → `instructions:`, `fullStream` → `stream`, `stepCountIs` →
  `isStepCount`; the SDK reports provider failure as an error *stream part*, not a throw.
- A test asserting TR-4521 was not owed delay credit failed two days into the build,
  because the order genuinely crossed from 2 to 4 business days late. The implementation
  was correct; the unpinned clock in the test was the bug.

Every one of those was caught by measurement rather than assumption, which is the point.
