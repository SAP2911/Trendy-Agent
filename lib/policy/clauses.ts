import { readFileSync } from 'node:fs';
import path from 'node:path';

export type ClauseId = string;

export interface Clause {
  id: ClauseId;
  section: string;
  title: string;
  text: string;
}

const EXPECTED_CLAUSE_COUNT = 29;

/**
 * Matches "**1.5 Delayed orders.** An order is considered..."
 *
 * Note `$(?![\s\S])` for end-of-input. JavaScript has no `\Z` — writing `\Z`
 * would silently match a literal "Z", and with the `m` flag a bare `$` matches
 * end-of-LINE, which would truncate every clause to its first line.
 *
 * The title group `([^*]+?)` is deliberately restricted to non-`*` characters:
 * several clause bodies (e.g. 1.6, 2.4, 4.1) contain their own mid-line
 * `**bold**` spans, but those never start at the beginning of a line, so they
 * cannot be confused with the next `**N.N` header by the lookahead below.
 */
const CLAUSE_RE =
  /^\*\*(\d+\.\d+)\s+([^*]+?)\*\*\s*([\s\S]*?)(?=^\*\*\d+\.\d+|^---|^##|$(?![\s\S]))/gm;
const SECTION_RE = /^##\s+(\d+)\.\s+(.+)$/gm;

/**
 * Pure parse function, exported so the build-time count assertion below is
 * testable without touching the checksum-protected trendly_policy.md: tests
 * can feed synthetic markdown and assert on the thrown error / fallback
 * behaviour directly.
 */
export function parse(markdown: string): Clause[] {
  const clauses: Clause[] = [];

  // With `noUncheckedIndexedAccess`, match[n] types as `string | undefined`.
  // The `!` assertions below are justified, not blind: every group asserted
  // is a MANDATORY (non-optional, non-alternated) capturing group in its
  // regex, so whenever the overall pattern matches, that group is guaranteed
  // to have captured a (possibly empty) string — never `undefined`. This is a
  // structural invariant of the regex, not an assumption about the input.
  const sectionTitles = new Map<string, string>();
  for (const m of markdown.matchAll(SECTION_RE)) {
    sectionTitles.set(m[1]!, m[2]!.trim());
  }

  for (const m of markdown.matchAll(CLAUSE_RE)) {
    const id = m[1]!;
    // id is always "<digits>.<digits>" per CLAUSE_RE's first group, so it
    // always contains a '.' and split()[0] is always defined.
    const sectionNumber = id.split('.')[0]!;
    clauses.push({
      id,
      // This fallback IS a real, testable branch: a clause whose section
      // number has no matching "## N. ..." heading (e.g. the doc was edited
      // to add a numbered clause without a section header) falls back to the
      // bare section number rather than losing the clause.
      section: sectionTitles.get(sectionNumber) ?? sectionNumber,
      title: m[2]!.trim().replace(/\.$/, ''),
      text: m[3]!.trim(),
    });
  }

  // §7 is a bulleted prohibition list with no numbered sub-clauses. Unlike
  // the assertions above, `s7` itself is a real, meaningful optional value:
  // if the policy document ever drops section 7, this branch is what allows
  // the missing-clause count to be detected below instead of parsing on
  // regardless.
  const s7 = markdown.match(/^##\s+7\.\s+(.+)$([\s\S]*?)(?=^---)/m);
  if (s7) {
    clauses.push({
      id: '7',
      section: 'What the assistant must not do',
      title: s7[1]!.trim(),
      text: s7[2]!.trim(),
    });
  }

  clauses.push({
    id: 'meta.source-of-truth',
    section: 'Meta',
    title: 'Policy authority',
    text: 'This is the only source of truth for policy questions. If something is not '
      + 'covered here, the assistant must say so and offer a human agent.',
  });
  clauses.push({
    id: 'meta.support-hours',
    section: 'Meta',
    title: 'Support hours',
    text: 'Trendly support hours are 9:00 AM – 9:00 PM IST, seven days a week.',
  });

  // Fail loudly if the policy file changes shape. A silently partial corpus
  // would make the agent confidently answer from an incomplete policy.
  if (clauses.length !== EXPECTED_CLAUSE_COUNT) {
    throw new Error(
      `Policy parse produced ${clauses.length} clauses, expected ${EXPECTED_CLAUSE_COUNT}. `
      + `trendly_policy.md may have been edited.`,
    );
  }
  return clauses;
}

function load(): Clause[] {
  // Read at root — the dataset must not be moved. See Global Constraints.
  const md = readFileSync(path.join(process.cwd(), 'trendly_policy.md'), 'utf8');
  return parse(md);
}

const clauses = load();

export function getClauses(): Clause[] {
  return clauses;
}

export function getClause(id: ClauseId): Clause | undefined {
  return clauses.find((c) => c.id === id);
}

/**
 * A compact index for the system prompt: enough for the model to know what the
 * policy covers (and therefore when it is silent), without spending ~1,500
 * tokens on full text every call. Groq free tier allows as little as 6K TPM.
 */
export function clauseIndexForPrompt(): string {
  return clauses
    .filter((c) => !c.id.startsWith('meta.'))
    .map((c) => `${c.id} ${c.title}`)
    .join('\n');
}
