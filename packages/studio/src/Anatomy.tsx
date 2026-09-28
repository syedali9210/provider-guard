import type { CallRecord } from '@core/records'
import { EMPTY_FLAG } from '@core/report'
import { type ReactNode, useEffect, useState } from 'react'
import type { Call } from './data'
import { ProviderChip, ResultLabel } from './Feed'
import { formatMs, num, relativeTime } from './format'
import { Button, IconCheck, IconCopy, IconFlag, IconX, Tooltip, useWidth } from './ui'

type Kind = 'reasoning' | 'text' | 'tool' | 'finish' | 'other'

export const kindOf = (type: string): Kind =>
  type.startsWith('reasoning')
    ? 'reasoning'
    : type.startsWith('text')
      ? 'text'
      : type.startsWith('tool')
        ? 'tool'
        : type === 'finish'
          ? 'finish'
          : 'other'

/** Shape and color both mark the part type, so color is never the only signal. */
function Mark({ kind, x, y }: { kind: Kind; x: number; y: number }) {
  switch (kind) {
    case 'reasoning':
      return <circle className="mark mark-reasoning" cx={x} cy={y} r={3.5} />
    case 'text':
      return <rect className="mark mark-text" x={x - 3.25} y={y - 3.25} width={6.5} height={6.5} />
    case 'tool':
      return <path className="mark mark-tool" d={`M${x} ${y - 4}L${x + 4} ${y + 3.5}H${x - 4}Z`} />
    case 'finish':
      return <rect className="mark mark-finish" x={x - 1.25} y={y - 6} width={2.5} height={12} />
    default:
      return <circle className="mark mark-other" cx={x} cy={y} r={1.75} />
  }
}

const LEGEND: Array<{ kind: Kind; label: string }> = [
  { kind: 'reasoning', label: 'Reasoning' },
  { kind: 'text', label: 'Text' },
  { kind: 'tool', label: 'Tool' },
  { kind: 'finish', label: 'Finish' },
]

function niceStep(max: number) {
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw) || 1
}

export function Timeline({ attempts }: { attempts: CallRecord[] }) {
  const t0 = Date.parse((attempts[0] as CallRecord).ts)
  const lanes = attempts.map((a, i) => ({
    record: a,
    offset: Date.parse(a.ts) - t0,
    label: `Attempt ${i + 1} · ${a.provider ?? 'unknown'}`,
    note: i === 0 ? null : 'spliced into the same stream',
  }))
  const end = Math.max(1, ...lanes.map((l) => l.offset + l.record.durationMs))
  const step = niceStep(end)
  const [figure, measured] = useWidth<HTMLElement>(460)
  const W = Math.max(280, measured)
  const left = 0
  const plot = W - left - 8
  const x = (ms: number) => left + (ms / end) * plot
  const laneHeight = 44
  const H = lanes.length * laneHeight + 24
  const streamed = attempts.some((a) => a.parts)

  return (
    <figure className="timeline" ref={figure}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={lanes
          .map(
            (l) =>
              `${l.label}: ${l.record.parts?.length ?? 0} stream parts over ${formatMs(l.record.durationMs)}${l.note ? `, ${l.note}` : ''}`,
          )
          .join('. ')}
      >
        {Array.from({ length: Math.floor(end / step) + 1 }, (_, i) => i * step).map((ms) => (
          <g key={ms}>
            <line className="axis-grid" x1={x(ms)} x2={x(ms)} y1={0} y2={H - 20} />
            <text
              className="axis-label"
              x={x(ms)}
              y={H - 6}
              textAnchor={ms === 0 ? 'start' : 'middle'}
            >
              {formatMs(ms)}
            </text>
          </g>
        ))}
        {lanes.map((l, i) => {
          const y = i * laneHeight + 26
          return (
            <g key={l.record.id}>
              <text className="lane-label" x={x(l.offset)} y={y - 12}>
                {l.label}
                {l.note && <tspan className="lane-note">{`  ${l.note}`}</tspan>}
              </text>
              <line
                className={`lane-bar${l.record.flags.length ? ' lane-caught' : ''}`}
                x1={x(l.offset)}
                x2={x(l.offset + l.record.durationMs)}
                y1={y}
                y2={y}
              />
              {(l.record.parts ?? []).map((p, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts have no ids and never reorder
                <Mark key={j} kind={kindOf(p.t)} x={x(l.offset + p.ms)} y={y} />
              ))}
            </g>
          )
        })}
      </svg>
      <figcaption className="legend text-label-12">
        {streamed ? (
          LEGEND.map((l) => (
            <span key={l.kind} className="legend-item">
              <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
                <Mark kind={l.kind} x={0} y={0} />
              </svg>
              {l.label}
            </span>
          ))
        ) : (
          <span>Generated without streaming, so there are no stream parts to plot.</span>
        )}
      </figcaption>
    </figure>
  )
}

/** The billed-but-empty rule, rendered as the actual checks with the recorded values. */
export function Evidence({ record }: { record: CallRecord }) {
  const matched = record.flags.includes(EMPTY_FLAG)
  const checks: Array<{ label: string; value: ReactNode; pass: boolean }> = [
    {
      label: 'Finish reason',
      value: <code>{record.finish ?? '—'}</code>,
      pass: record.finish === 'stop',
    },
    {
      label: 'Text tokens billed',
      value: <code>{num(record.tokens.text)}</code>,
      pass: (record.tokens.text ?? 0) > 0,
    },
    {
      label: 'Text delivered',
      value: <code>{record.delivered.textChars} chars</code>,
      pass: record.delivered.textChars === 0,
    },
    {
      label: 'Tool calls',
      value: <code>{record.delivered.toolCalls}</code>,
      pass: record.delivered.toolCalls === 0,
    },
  ]
  const others = record.flags.filter((f) => f !== EMPTY_FLAG)
  return (
    <div className="evidence">
      {matched && (
        <>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.label} className={c.pass ? 'check-pass' : 'check-fail'}>
                <span className="check-label">{c.label}</span>
                <span className="check-value text-label-13-mono">{c.value}</span>
                {c.pass ? <IconCheck className="check-icon" /> : <IconX className="check-icon" />}
                <span className="sr-only">{c.pass ? 'matches' : 'does not match'}</span>
              </li>
            ))}
          </ul>
          <p className="evidence-verdict text-label-14">
            <IconFlag /> Matched billed-but-empty
          </p>
        </>
      )}
      {others.map((flag) => (
        <p key={flag} className="evidence-verdict text-label-14">
          Flagged by <code>{flag}</code>
        </p>
      ))}
    </div>
  )
}

function CopyId({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const button = (
    <Button
      svgOnly
      size="tiny"
      variant="tertiary"
      aria-label={`Copy ${label.toLowerCase()}`}
      disabled={value === null}
      onClick={() => {
        if (value === null) return
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </Button>
  )
  return (
    <div className="id-row">
      <dt className="text-label-13">{label}</dt>
      <dd className="text-label-13-mono">
        <span className="id-value">{value ?? '—'}</span>
        {value === null ? (
          <Tooltip text={`No ${label.toLowerCase()} was recorded for this call`}>{button}</Tooltip>
        ) : (
          button
        )}
        <span className="sr-only" aria-live="polite">
          {copied ? `${label} copied` : ''}
        </span>
      </dd>
    </div>
  )
}

const sum = (values: Array<number | null>) =>
  values.every((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0)

export function CallAnatomy({
  call,
  now,
  onClose,
}: {
  call: Call
  now: number
  onClose: () => void
}) {
  const attempts = call.second ? [call.first, call.second] : [call.first]
  const flagged = attempts.filter((a) => a.flags.length > 0)
  const totals = {
    in: sum(attempts.map((a) => a.tokens.in)),
    out: sum(attempts.map((a) => a.tokens.out)),
    text: sum(attempts.map((a) => a.tokens.text)),
    reasoning: sum(attempts.map((a) => a.tokens.reasoning)),
  }
  return (
    <div className="anatomy">
      <header className="anatomy-header">
        <div className="anatomy-title-row">
          <h2 id="anatomy-title" className="text-heading-20">
            Call Anatomy
          </h2>
          <Button svgOnly variant="tertiary" aria-label="Close" onClick={onClose} data-autofocus>
            <IconX />
          </Button>
        </div>
        <p className="anatomy-model text-label-14-mono">{call.first.model}</p>
        <p className="text-label-13 anatomy-meta">
          <time dateTime={call.first.ts}>{relativeTime(call.ts, now)}</time> · {call.first.mode} ·{' '}
          <ResultLabel call={call} />
        </p>
        <ol className="attempt-chips" aria-label="Attempts in order">
          {attempts.map((a, i) => (
            <li key={a.id}>
              {i > 0 && <span aria-hidden="true">→</span>}
              <ProviderChip provider={a.provider} flagged={a.flags.length > 0} />
            </li>
          ))}
        </ol>
        <dl className="ids">
          <CopyId label="Record ID" value={call.first.id} />
          <CopyId label="Generation ID" value={call.first.generationId} />
        </dl>
      </header>

      <section aria-labelledby="timeline-title" className="anatomy-section">
        <h3 id="timeline-title" className="text-heading-14">
          Timeline
        </h3>
        <Timeline attempts={attempts} />
      </section>

      {flagged.length > 0 && (
        <section aria-labelledby="evidence-title" className="anatomy-section">
          <h3 id="evidence-title" className="text-heading-14">
            Why It Was Caught
          </h3>
          {flagged.map((a) => (
            <div key={a.id}>
              {attempts.length > 1 && (
                <p className="text-label-13 evidence-attempt">
                  Attempt {attempts.indexOf(a) + 1} · {a.provider ?? 'unknown'}
                </p>
              )}
              <Evidence record={a} />
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="totals-title" className="anatomy-section">
        <h3 id="totals-title" className="text-heading-14">
          Totals
        </h3>
        <dl className="totals">
          <div>
            <dt className="text-label-13">Input Tokens</dt>
            <dd className="text-label-14-mono">{num(totals.in)}</dd>
          </div>
          <div>
            <dt className="text-label-13">Output Tokens</dt>
            <dd className="text-label-14-mono">{num(totals.out)}</dd>
          </div>
          <div>
            <dt className="text-label-13">Text</dt>
            <dd className="text-label-14-mono">{num(totals.text)}</dd>
          </div>
          <div>
            <dt className="text-label-13">Reasoning</dt>
            <dd className="text-label-14-mono">{num(totals.reasoning)}</dd>
          </div>
        </dl>
        {attempts.length > 1 && (
          <p className="text-copy-13 totals-note">
            Summed across both attempts. Both were billed, so this is what the call cost.
          </p>
        )}
      </section>
    </div>
  )
}
