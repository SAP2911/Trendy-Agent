# ADR 0002 — Hand-written orchestration loop, not the SDK's agent loop

**Status:** Accepted · 2026-08-04

## Context
AI SDK 7 ships a capable agent loop (`stopWhen: isStepCount(n)`). The assignment states
that orchestration — how the agent decides, chains steps, recovers from failure, and
carries state — is one of two primary assessment axes, and that the author must be able to
explain and modify the code live.

## Decision
Use AI SDK 7 for provider adapters, streaming and tool typing. Hand-write the loop itself:
input guards → plan → authorize → execute → output guards → repair.

## Consequences
**Positive.** Explicit control over the five things being assessed: guard placement before
any model call, per-stage trace emission with correlation IDs, the one-shot repair cycle,
provider failover behind a circuit breaker, and session-state-driven `activeTools` gating.
The loop is inspectable, demonstrable on camera, and defensible line by line. An agent
hidden behind one config line offers none of that.

**Negative.** More code to own and test than a single SDK call. `isStepCount` is retained
only as a backstop ceiling.

**Validated in practice.** Owning the loop is what allowed failover to detect that the SDK
surfaces provider failures as an `{type:'error'}` stream part rather than throwing — a
behaviour no tutorial documents, and one the built-in loop would have swallowed.
