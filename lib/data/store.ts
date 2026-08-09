export interface ReturnInput { orderId: string; sku: string; resolution: 'refund' | 'exchange' }
export interface ExchangeInput { orderId: string; sku: string; fromSize: string; toSize: string }
export interface TicketInput {
  reasonCode: string; conversationId: string; correlationId: string;
  customerId: string | null; orderIds: string[]; situation: string;
  attempted: string[]; policyRefs: string[]; suggestedResolution: string;
}

interface Stored { id: string }

const returns = new Map<string, Stored>();
const exchanges = new Map<string, Stored>();
const credits = new Map<string, Stored>();
const tickets = new Map<string, TicketInput & Stored>();

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(5, '0')}`;
}

/**
 * Idempotency is required, not optional: retries are inevitable in an agent
 * loop, and a duplicated RMA or a twice-issued ₹250 credit is a real defect.
 */
function upsert(
  map: Map<string, Stored>, key: string, prefix: string,
): { id: string; created: boolean } {
  const existing = map.get(key);
  if (existing) return { id: existing.id, created: false };
  const record = { id: nextId(prefix) };
  map.set(key, record);
  return { id: record.id, created: true };
}

export function createReturn(input: ReturnInput): { rmaId: string; created: boolean } {
  const { id, created } = upsert(returns, `${input.orderId}:${input.sku}:return`, 'RMA');
  return { rmaId: id, created };
}

/**
 * Idempotency is keyed on the requested SIZE as well as the item.
 *
 * Keying on `(orderId, sku)` alone conflates two different events: a retry of
 * the same request, and a genuinely NEW exchange for a different size. §4.4
 * allows one exchange per item and sends the second to a human, so collapsing
 * them meant a second exchange silently returned the first one's id and the
 * approval requirement never fired. See findItemExchange below.
 */
export function createExchange(input: ExchangeInput): { exchangeId: string; created: boolean } {
  const key = `${input.orderId}:${input.sku}:exchange:${input.toSize.trim().toLowerCase()}`;
  const { id, created } = upsert(exchanges, key, 'EXC');
  return { exchangeId: id, created };
}

/**
 * The exchange already on file for this item, if any, regardless of size.
 *
 * §4.4: "One exchange per item. A second exchange request on the same item
 * requires human approval." This is how the mutating tool distinguishes a
 * retry (same size — idempotent, returns the same id) from a second request
 * (different size — must be escalated, never auto-created).
 */
export function findItemExchange(
  orderId: string, sku: string,
): { exchangeId: string; toSize: string } | undefined {
  const prefix = `${orderId}:${sku}:exchange:`;
  for (const [key, record] of exchanges) {
    if (key.startsWith(prefix)) {
      return { exchangeId: record.id, toSize: key.slice(prefix.length) };
    }
  }
  return undefined;
}

export function issueCredit(orderId: string, amountInr: number): { creditId: string; created: boolean } {
  const { id, created } = upsert(credits, `${orderId}:credit:${amountInr}`, 'CRD');
  return { creditId: id, created };
}

export function createTicket(input: TicketInput): { ticketId: string } {
  const id = nextId('TKT');
  tickets.set(id, { ...input, id });
  return { ticketId: id };
}

export function getTicket(ticketId: string): (TicketInput & Stored) | undefined {
  return tickets.get(ticketId);
}

/** Test-only reset. Production state is per-process and intentionally ephemeral. */
export function resetStore(): void {
  returns.clear(); exchanges.clear(); credits.clear(); tickets.clear();
  counter = 0;
}
