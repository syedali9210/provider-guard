import type { CallRecord } from '@core/records'
import {
  buildReport,
  EFFORT_RULE,
  formatP,
  type ModelReport,
  OUTLIER_RULE,
  type ReasoningPanel,
} from '@core/report'
import type { ReasoningLevel } from '@core/types'
import { useMemo } from 'react'
import { num } from './format'
import { Badge, IconWarning, Tooltip } from './ui'

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`

const OUTLIER_HELP = `One-sided Fisher exact test of this provider's empty rate against every other provider of the model. Flagged at ${OUTLIER_RULE.minCalls}+ calls, ${pct(OUTLIER_RULE.minEmptyRate)}+ empty, and p < ${OUTLIER_RULE.maxP}.`

function EmptyRate({ empty, rate, outlier }: { empty: number; rate: number; outlier: boolean }) {
  return (
    <span className="rate">
      <span className="rate-bar" aria-hidden="true">
        <span
          className={`rate-fill${outlier ? ' rate-outlier' : ''}`}
          style={{ width: `${Math.min(100, rate * 100)}%` }}
        />
      </span>
      <span className="text-label-13-mono">
        {num(empty)} ({pct(rate, 1)})
      </span>
    </span>
  )
}

function ProviderTable({ model }: { model: ModelReport }) {
  return (
    <table className="table providers-table">
      <caption className="sr-only">Provider health for {model.model}</caption>
      <thead>
        <tr>
          <th scope="col">Provider</th>
          <th scope="col" className="num">
            Calls
          </th>
          <th scope="col">Empty</th>
          <th scope="col" className="num">
            Reasoned
          </th>
          <th scope="col" className="num" title="Median reasoning tokens">
            Median Reasoning
          </th>
          <th scope="col">
            <span className="sr-only">Outlier</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {model.providers.map((p) => (
          <tr key={p.provider}>
            <th scope="row" className="text-label-13-mono">
              {p.provider}
            </th>
            <td className="num text-label-13-mono">{num(p.attempts)}</td>
            <td>
              <EmptyRate empty={p.empty} rate={p.emptyRate} outlier={p.outlier} />
            </td>
            <td className="num text-label-13-mono">{pct(p.reasonedRate)}</td>
            <td className="num text-label-13-mono">{num(p.medianReasoningTokens)}</td>
            <td>
              {p.outlier && p.p !== null && (
                <span className="outlier">
                  <Badge variant="red" icon={<IconWarning size={12} />}>
                    Outlier
                  </Badge>
                  <Tooltip text={OUTLIER_HELP}>
                    {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the tooltip opens from the keyboard */}
                    <span className="text-label-12-mono p-value" tabIndex={0}>
                      {formatP(p.p)}
                    </span>
                  </Tooltip>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Levels are styled by position: the lowest requested level is hollow, higher ones filled. */
const levelClass = (levels: ReasoningLevel[], level: ReasoningLevel) =>
  `level-${levels.indexOf(level)}`

/** One row per provider; each run is a dot, grouped by requested effort level. */
export function DotPlot({ panel }: { panel: ReasoningPanel }) {
  const values = panel.rows.flatMap((r) => Object.values(r.runs).flat() as number[])
  const max = Math.max(1, ...values) * 1.08
  const W = 520
  const labelWidth = 96
  const plot = W - labelWidth - 12
  const x = (v: number) => labelWidth + (v / max) * plot
  const rowHeight = 36
  const H = panel.rows.length * rowHeight + 28
  const step = 10 ** Math.floor(Math.log10(max / 2))
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step).filter(
    (_, i, all) => all.length <= 8 || i % 2 === 0,
  )
  const summary = panel.rows
    .map(
      (r) =>
        `${r.provider}: ${panel.levels.map((l) => `${l} median ${num(r.medians[l])}`).join(', ')}${r.effortIgnored ? ', effort appears ignored' : ''}`,
    )
    .join('. ')

  return (
    <figure className="dotplot">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Reasoning tokens per run. ${summary}.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="axis-grid" x1={x(t)} x2={x(t)} y1={4} y2={H - 22} />
            <text className="axis-label" x={x(t)} y={H - 8} textAnchor="middle">
              {num(t)}
            </text>
          </g>
        ))}
        {panel.rows.map((r, i) => {
          const y = i * rowHeight + 20
          return (
            <g key={r.provider}>
              <text className="row-label" x={0} y={y + 4}>
                {r.provider}
              </text>
              <line className="row-rule" x1={labelWidth} x2={W - 12} y1={y} y2={y} />
              {panel.levels.map((level) => {
                const runs = r.runs[level] ?? []
                const median = r.medians[level]
                return (
                  <g key={level} className={`level ${levelClass(panel.levels, level)}`}>
                    {median !== undefined && (
                      <line
                        className="median-tick"
                        x1={x(median)}
                        x2={x(median)}
                        y1={y - 9}
                        y2={y + 9}
                      />
                    )}
                    {runs.map((v, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
                      <circle key={j} className="run-dot" cx={x(v)} cy={y} r={4.5} />
                    ))}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      <figcaption className="legend text-label-12">
        {panel.levels.map((level) => (
          <span key={level} className={`legend-item level ${levelClass(panel.levels, level)}`}>
            <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
              <circle className="run-dot" r={4.5} />
            </svg>
            {level}
          </span>
        ))}
        <span className="legend-item">
          <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
            <line className="median-tick" x1={0} x2={0} y1={-5} y2={5} />
          </svg>
          median
        </span>
      </figcaption>
    </figure>
  )
}

function ReasoningSection({ panel }: { panel: ReasoningPanel }) {
  return (
    <section aria-labelledby="reasoning-title" className="providers-section">
      <h3 id="reasoning-title" className="text-heading-16">
        Reasoning by Effort Level
      </h3>
      <p className="text-copy-13 section-help">
        Reasoning tokens per run at each requested effort. A provider whose medians move less than{' '}
        {pct(EFFORT_RULE.maxFlatChange)} between {panel.levels[0]} and {panel.levels.at(-1)}, while
        another moves at least {EFFORT_RULE.minRatio}x, is flagged.
      </p>
      <DotPlot panel={panel} />
      <table className="table reasoning-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            {panel.levels.map((l) => (
              <th key={l} scope="col" className="num">
                {l}
              </th>
            ))}
            <th scope="col">
              <span className="sr-only">Flag</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {panel.rows.map((r) => (
            <tr key={r.provider}>
              <th scope="row" className="text-label-13-mono">
                {r.provider}
              </th>
              {panel.levels.map((l) => (
                <td key={l} className="num text-label-13-mono">
                  {num(r.medians[l])}
                </td>
              ))}
              <td>
                {r.effortIgnored && (
                  <span className="effort-flag text-label-13">
                    <IconWarning size={14} />
                    effort appears ignored
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function Providers({
  records,
  selected,
  onSelect,
}: {
  records: CallRecord[]
  selected: string | null
  onSelect: (model: string) => void
}) {
  const report = useMemo(() => buildReport(records), [records])
  const model = report.find((m) => m.model === selected) ?? report[0]
  if (!model) return null

  return (
    <div className="providers">
      <nav className="model-list" aria-label="Models">
        <ul>
          {report.map((m) => (
            <li key={m.model}>
              <button
                type="button"
                className="model-item"
                aria-current={m.model === model.model ? 'true' : undefined}
                onClick={() => onSelect(m.model)}
              >
                <span className="text-label-13-mono model-name">{m.model}</span>
                <span className="text-label-12 model-counts">
                  {num(m.attempts)} calls · {num(m.caught)} caught
                  {m.providers.some((p) => p.outlier) && (
                    <span className="model-outlier">
                      <IconWarning size={12} />
                      outlier
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="model-detail">
        <header className="model-header">
          <h2 className="text-heading-20 text-mono-heading">{model.model}</h2>
          <p className="text-label-13">
            {num(model.attempts)} calls · {num(model.caught)} caught
          </p>
        </header>
        <section aria-label="Providers" className="providers-section">
          <ProviderTable model={model} />
        </section>
        {model.reasoning && <ReasoningSection panel={model.reasoning} />}
      </div>
    </div>
  )
}
