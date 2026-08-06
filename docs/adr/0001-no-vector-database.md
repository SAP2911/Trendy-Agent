# ADR 0001 — No vector database for policy retrieval

**Status:** Accepted · 2026-08-04

## Context
The assistant must answer policy questions grounded only in `trendly_policy.md`
(5.9 KB, 29 addressable clauses). The reflexive choice is embeddings + a vector store.

## Decision
Use BM25 over build-time-parsed clauses, plus a curated alias map. No embeddings,
no vector store.

## Consequences
**Positive.** Deterministic and unit-testable — the same query always returns the same
clauses, so retrieval quality is asserted in CI rather than eyeballed. Zero extra
dependencies and no network at query time. More accurate at this corpus size than
semantic search, which needs volume to beat lexical matching.

Crucially it makes a **`NO_COVERAGE`** signal natural: when the best BM25 score falls below
a calibrated threshold, retrieval reports silence. Policy §7 requires the assistant to say
it does not know rather than invent, and a retriever that always returns its nearest match
hands the model material to rationalise an answer from. That is the single most likely path
to invented policy.

**Negative.** Lexical matching cannot bridge vocabulary gaps unaided; the alias map is
hand-maintained. Two realistic phrasings currently fall to `NO_COVERAGE` — both fail in the
safe direction (offer a human), and the fix is adding aliases.

**Revisit if** the policy grows past a few hundred clauses or becomes multilingual.
