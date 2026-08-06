'use client';

import type { TraceEvent } from '@/lib/obs/trace';
import styles from './TracePanel.module.css';
import {
  toneForCode, toneForValidator, shortToolName,
} from './trace-format';
import {
  ActivityIcon, ChevronIcon, ShieldIcon, WrenchIcon, AlertIcon,
} from './icons';

interface TracePanelProps {
  events: TraceEvent[];
  streaming: boolean;
  correlationId: string | null;
}

/**
 * The instrument-readout twin of the chat pane: every orchestration event
 * runTurn() emits, rendered as it streams in, so a viewer can SEE guards,
 * tool calls, policy citations, and repair passes happen instead of just
 * being told the agent "did some checks". Deliberately dense and
 * monospace — this panel intentionally does not track the app's
 * light/dark theme (see TracePanel.module.css) so it always reads like a
 * technical console next to the warm conversational pane.
 */
export function TracePanel({ events, streaming, correlationId }: TracePanelProps) {
  return (
    <section className={styles.panel} aria-label="Live reasoning trace">
      <header className={styles.header}>
        <div className={styles.title}>
          <ActivityIcon width={16} height={16} />
          <span>Live reasoning trace</span>
        </div>
        <div className={styles.status} data-live={streaming ? 'true' : 'false'}>
          <span className={styles.pulseDot} />
          {streaming ? 'streaming' : 'idle'}
        </div>
      </header>

      {correlationId && (
        <div className={styles.correlation}>
          corr:
          {' '}
          {correlationId}
        </div>
      )}

      <div className={styles.body}>
        {events.length === 0 ? (
          <p className={styles.empty}>
            No orchestration yet. Send a message — guard checks, tool calls, policy
            citations, and validator verdicts will appear here as they happen, live.
          </p>
        ) : (
          <ol className={styles.list}>
            {events.map((event) => (
              <li key={event.seq} className={styles.row}>
                <span className={styles.seq}>{String(event.seq).padStart(2, '0')}</span>
                <div className={styles.rowBody}>
                  <TraceRow event={event} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function TraceRow({ event }: { event: TraceEvent }) {
  switch (event.type) {
    case 'guard':
      return <GuardRow event={event} />;
    case 'plan':
      return <PlanRow event={event} />;
    case 'tool_call':
      return <ToolCallRow event={event} />;
    case 'tool_result':
      return <ToolResultRow event={event} />;
    case 'validator':
      return <ValidatorRow event={event} />;
    case 'failover':
      return <FailoverRow event={event} />;
    case 'escalation':
      return <EscalationRow event={event} />;
    default:
      return null;
  }
}

function GuardRow({ event }: { event: Extract<TraceEvent, { type: 'guard' }> }) {
  const tone = event.verdict === 'pass' ? 'success' : 'denied';
  return (
    <div className={styles.line}>
      <ShieldIcon width={13} height={13} className={styles.lineIcon} />
      <span className={styles.label}>
        guard·
        {event.name}
      </span>
      <span className={styles.chip} data-tone={tone}>{event.verdict}</span>
      {event.detail && <span className={styles.detail}>{event.detail}</span>}
    </div>
  );
}

function PlanRow({ event }: { event: Extract<TraceEvent, { type: 'plan' }> }) {
  return (
    <div className={styles.line}>
      <span className={styles.label}>plan</span>
      <span className={styles.chip} data-tone="neutral">{event.provider}</span>
      <span className={styles.detail}>
        {event.latencyMs}
        ms
      </span>
    </div>
  );
}

function ToolCallRow({ event }: { event: Extract<TraceEvent, { type: 'tool_call' }> }) {
  const hasArgs = event.args !== undefined
    && event.args !== null
    && !(typeof event.args === 'object' && Object.keys(event.args as object).length === 0);

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>
        <WrenchIcon width={13} height={13} className={styles.lineIcon} />
        <span className={styles.label}>
          call·
          {shortToolName(event.name)}
        </span>
        {hasArgs && <ChevronIcon width={12} height={12} className={styles.chevron} />}
      </summary>
      {hasArgs && (
        <pre className={styles.args}>{JSON.stringify(event.args, null, 2)}</pre>
      )}
    </details>
  );
}

function ToolResultRow({ event }: { event: Extract<TraceEvent, { type: 'tool_result' }> }) {
  const tone = toneForCode(event.code);
  return (
    <div className={styles.line}>
      <span className={styles.label}>
        result·
        {shortToolName(event.name)}
      </span>
      <span className={styles.chip} data-tone={tone}>{event.code}</span>
      {event.clauses?.map((clause) => (
        <span key={clause} className={styles.clausePill}>
          §
          {clause}
        </span>
      ))}
    </div>
  );
}

function ValidatorRow({ event }: { event: Extract<TraceEvent, { type: 'validator' }> }) {
  const tone = toneForValidator(event.verdict);
  const prominent = event.verdict !== 'pass';
  return (
    <div className={styles.line} data-prominent={prominent ? 'true' : 'false'}>
      <span className={styles.label}>
        validator·
        {event.name}
      </span>
      <span className={styles.chip} data-tone={tone}>{event.verdict}</span>
      {event.verdict === 'repair' && (
        <span className={styles.detail}>reply rewritten before reaching the customer</span>
      )}
    </div>
  );
}

function FailoverRow({ event }: { event: Extract<TraceEvent, { type: 'failover' }> }) {
  return (
    <div className={styles.banner} data-tone="warning">
      <AlertIcon width={14} height={14} />
      <div>
        <strong>
          {event.from}
          {' → '}
          {event.to}
        </strong>
        <div className={styles.bannerDetail}>{event.reason}</div>
      </div>
    </div>
  );
}

function EscalationRow({ event }: { event: Extract<TraceEvent, { type: 'escalation' }> }) {
  return (
    <div className={styles.banner} data-tone="escalation">
      <ActivityIcon width={14} height={14} />
      <div>
        <strong>Escalated to a human agent</strong>
        <div className={styles.bannerDetail}>
          {event.reasonCode}
          {' · '}
          {event.ticketId}
        </div>
      </div>
    </div>
  );
}
