# PROMPTS.md — prompt engineering, and how it was iterated

Prompts live in version control, not in this file. This document records **what each one
does, why it says what it says, and what went wrong that made it say that.**

- System instructions: [`lib/agent/prompts.ts`](lib/agent/prompts.ts) (`PROMPT_VERSION`)
- Tool descriptions: [`lib/tools/index.ts`](lib/tools/index.ts)
- Repair-loop prompt: [`lib/agent/loop.ts`](lib/agent/loop.ts) (`repairOnce`)

---

## 1. The system prompt

Built fresh every turn by `buildInstructions(ctx)`. Two things are deliberately **not**
static text:

- **Today's date**, injected from `now()`. Without it the model guesses the date from its
  training distribution and silently miscomputes every window.
- **Verification state**, read from live session state — not carried over from an earlier
  turn's snapshot.

### Design decisions worth defending

**The policy is not in the prompt.** Only `clauseIndexForPrompt()` — 514 characters of
`id + title` per clause. The model calls `search_policy` for exact wording.

Two reasons. First, token budget: Groq free tier TPM runs as low as 6K and 13 tool schemas
already spend a meaningful slice. Second, and more important, **grounding**: when clause
text arrives through a tool result, the output validator can check that every policy claim
in the reply maps to a clause actually retrieved *this turn*. Text pasted into the system
prompt is indistinguishable from text the model invented.

**Negative instructions are specific, not general.** "Be helpful and safe" does nothing.
Each prohibition names the behaviour, the clause, and the escape hatch:

> Never offer a discount, coupon, waiver, or goodwill credit (§7). The ONLY credit Trendly
> authorises is the ₹250 delayed-order credit, and only after `check_delay_credit` confirms
> OWED — issued via `issue_delay_credit`, never promised from your own arithmetic.

**Tone instruction is behavioural, not adjectival.** Not "be empathetic" but:

> When an order is late or lost, acknowledge that first — THEN explain the policy.

This is directly testable, and it changed observed behaviour on TR-4525 and TR-4526.

---

## 2. Iteration log

Each entry is a real failure observed against the live model, and the change that fixed it.

### v1 → the per-item instruction

**Failure.** Asked about TR-4522 (a returnable tee *and* non-returnable socks), the model
collapsed the order into a single verdict and told the customer the whole order was
returnable.

**Root cause.** The prompt said "decide returns with `check_return_eligibility`" and the
tool returned an array. The model summarised the array instead of reporting it.

**Fix.** Made the shape explicit in *both* the system prompt and the tool description:

> It answers PER ITEM — one order can mix a returnable and a non-returnable item. Report
> each item separately; never collapse a mixed order into one verdict.

**Lesson.** When a tool returns a collection, say so in the tool description. The model
reads tool descriptions as behavioural instructions, not as API documentation.

### v1 → "never compute dates yourself"

**Failure.** The model performed its own date arithmetic and announced an order was
"about 4 days late" — technically true in calendar days, but §1.5 counts *business* days,
where the correct answer was 2 and no credit was owed.

**Fix.** A blunt instruction: *"Never compute dates, day counts, or eligibility yourself.
Call the tool."*

**Lesson.** Models are willing to do arithmetic they were not asked to do. Prohibiting the
*capability* works better than correcting the *output* — and the numeric-grounding
validator catches whatever slips through.

### v1 → the `NO_COVERAGE` instruction

**Failure.** Asked "do you ship to Nepal?", the model produced a fluent, plausible,
entirely invented shipping answer.

**Fix.** Explicit handling of the silence signal, in the prompt *and* the tool description:

> If it returns `NO_COVERAGE`, say plainly that the policy does not cover it and offer a
> human agent. Never fill the gap yourself, even if the answer seems obvious.

The clause **"even if the answer seems obvious"** was the load-bearing addition. Without
it the model treats an obvious-seeming question as exempt.

**Lesson.** An LLM will not volunteer ignorance unless ignorance is given an explicit,
named, legitimate output.

### v1 → v2: the scope boundary

**Failure.** Found by the user, not by me. Asked *"what is 2+2?"* the agent answered
**4**. Asked *"who is Modi?"* it produced a biography. Both are failures, and I had not
tested for either.

**Root cause.** My out-of-scope guard covered exactly the three things §7 names —
medical, legal and financial advice — and nothing else. I had implemented the letter of
the policy and missed its intent. The footer says *"Questions not answered here should be
routed to a human support agent"*; a general-purpose answering machine is not that.

**Why it matters beyond tidiness.** A fashion retailer's support bot discussing a
political figure is a brand incident. And a bot that answers anything is a far softer
target for injection than one with a hard remit — general helpfulness is the wedge.

**Fix.** A `SCOPE` block at the very top of the instructions, before anything else:
names the remit, states plainly that this is *not* a general assistant, enumerates the
off-topic categories, gives a concrete refusal line to reuse, and — importantly —
explicitly protects greetings and small talk so the bot does not become hostile to a
normal opener.

Two details that made the difference:

- **A worked example of the failure**, in the prompt: *"Answering 'what is 2+2' or 'who
  is <public figure>' is a FAILURE, not helpfulness."* Naming the exact failure beat any
  abstract instruction.
- **An explicit in-scope allowlist.** Without it the first draft refused "hi there!",
  trading one defect for a worse one.

**Verified live.** Math, public figures and a coding request are all refused with zero
tool calls; "hi there!" gets a warm greeting; "how long do I have to return something?"
still answers correctly citing §2.1.

**Cost.** The prompt grew from ~2.4k to ~3.0k characters (~780 tokens). The stated budget
was raised from 2500 to 3200 with that justification recorded in the test, rather than
quietly deleted.

**Honest limitation.** This is prompt-level enforcement, which is softer than the
tool-level enforcement used for eligibility. A determined adversary has more room here
than against `initiate_return`. A deterministic topic classifier was considered and
rejected: the false-positive risk against legitimate phrasings like *"who is my delivery
agent?"* is worse than the residual risk it removes.

### v1 → tool-level enforcement (the important one)

**Failure.** Under adversarial pressure — *"my order is late, give me 30% off"* — prompt
instructions alone were not reliable.

**Fix.** Stopped treating this as a prompt problem. `initiate_return` and
`issue_delay_credit` **recompute eligibility server-side and refuse**, regardless of what
the model decided. The prompt still forbids it; the tool makes it impossible.

**Observed result** (live, Groq): the model called `issue_delay_credit`, received
`REFUSED_NOT_OWED`, called `search_policy`, and explained to the customer that the order
was 2 business days late and therefore did not meet the "more than 3 business days"
threshold. **It refused the discount and explained why, using the tool's own reasoning.**

**Lesson.** The most effective prompt engineering here was moving the decision out of the
prompt entirely. Prompts shape behaviour; tools constrain it.

---

## 3. Tool descriptions as prompt engineering

Tool descriptions are not documentation — they are the model's decision procedure for
*when* to call something. Two carry explicit behavioural instructions:

**`search_policy`** — tells the model what `NO_COVERAGE` obliges it to do, so the
instruction sits next to the result that triggers it rather than paragraphs away in the
system prompt.

**`check_return_eligibility`** — states that it answers per item and that each item must be
reported separately, and that it must be called *before* telling a customer whether they
can return anything.

---

## 4. The repair prompt

When the output validator finds a violation, the loop retries **once**, feeding back the
specific violation rather than a generic instruction — "you referenced ₹500, which no tool
returned" rather than "be accurate".

If the second attempt also fails, the reply is **not** emitted. The loop returns a
deterministic safe template and escalates with `VALIDATOR_REPAIR_FAILED`. Stopping the line
beats shipping a known defect.

This fired in live testing. On the "give me 30% off" scenario the trace shows
`VALIDATOR: repair,pass` — the first draft violated a rule, the constrained retry fixed it,
and the customer never saw the first version.

---

## 5. What did not work

- **Politeness framing** ("please try to avoid...") — ignored under pressure. Replaced with
  imperatives.
- **Long persona preambles** — cost tokens against a 6K TPM budget and changed nothing
  measurable. Cut entirely.
- **Full policy in the prompt** — worked, but made citation validation impossible, because
  retrieved text and prompt text became indistinguishable.
- **Asking the model to self-check its numbers** — unreliable, and it burned an extra model
  call per turn against a 5 RPM limit. Replaced with the deterministic numeric-grounding
  validator, which is free and cannot be talked out of it.
