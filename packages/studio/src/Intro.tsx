import { type ReactNode, useEffect, useState } from 'react'
import type { Call } from './data'
import { ProviderPath, ResultLabel } from './Feed'
import { Button, IconRestart, IconX, useReducedMotion } from './ui'

// "How It Works": why provider-guard exists, told as small animated flow diagrams, then how to
// read the screen. Shown in the replay demo only; it never shows prompt or response content.

type NodeId = 'app' | 'guard' | 'gateway' | 'baseten' | 'zai' | 'fireworks'
type Tone = 'request' | 'answer' | 'error' | 'empty'
type Mark = [text: string, tone: 'ok' | 'bad' | 'neutral']

/** One beat of a diagram: where the call is, what it carries, and the labels that appear. */
type Frame = { at: NodeId; tone: Tone; marks?: Partial<Record<NodeId, Mark>>; flag?: true }
type Diagram = { alt: string; frames: Frame[] }

const FRAME_MS = 600
const PROVIDERS = ['baseten', 'zai', 'fireworks'] as const
const POS: Record<NodeId, [number, number]> = {
  app: [40, 88],
  guard: [132, 88],
  gateway: [224, 88],
  baseten: [336, 34],
  zai: [336, 88],
  fireworks: [336, 142],
}
const MARK_POS: Record<NodeId, [number, number]> = {
  app: [40, 126],
  guard: [132, 64],
  gateway: [224, 62],
  baseten: [336, 12],
  zai: [336, 116],
  fireworks: [336, 170],
}

const issue = (n: number) => (
  <a href={`https://github.com/vercel/ai/issues/${n}`} target="_blank" rel="noreferrer">
    vercel/ai#{n}
  </a>
)

type Step = { title: string; body: ReactNode; diagram?: Diagram }

const STEPS: Step[] = [
  {
    title: 'One Model, Many Providers',
    body: (
      <p>
        AI Gateway serves a model like <code>zai/glm-5.3-flash</code> from several providers. Each
        call goes to one of them, and the answer comes back to your app.
      </p>
    ),
    diagram: {
      alt: 'Your app sends a call to AI Gateway, which routes it to zai. The answer returns to your app.',
      frames: [
        { at: 'app', tone: 'request' },
        { at: 'gateway', tone: 'request' },
        { at: 'zai', tone: 'request' },
        { at: 'gateway', tone: 'answer' },
        { at: 'app', tone: 'answer', marks: { app: ['answer', 'ok'] } },
      ],
    },
  },
  {
    title: 'Errors Fall Back',
    body: (
      <p>
        When a provider fails, the gateway retries the call on another provider. Your app never sees
        the error.
      </p>
    ),
    diagram: {
      alt: 'The call goes to baseten, which fails. AI Gateway retries it on zai, and the answer returns to your app.',
      frames: [
        { at: 'app', tone: 'request' },
        { at: 'gateway', tone: 'request' },
        { at: 'baseten', tone: 'request' },
        { at: 'baseten', tone: 'error', marks: { baseten: ['error', 'bad'] } },
        { at: 'gateway', tone: 'request', marks: { gateway: ['retried', 'neutral'] } },
        { at: 'zai', tone: 'request' },
        { at: 'gateway', tone: 'answer' },
        { at: 'app', tone: 'answer', marks: { app: ['answer', 'ok'] } },
      ],
    },
  },
  {
    title: "Empty Successes Don't",
    body: (
      <p>
        A provider can answer 200, bill text tokens, and send no text. Nothing failed, so nothing
        falls back, and your app gets an empty answer. In {issue(20932)}, Baseten did this in 22 of
        51 reasoned calls with tools.
      </p>
    ),
    diagram: {
      alt: 'The call goes to baseten, which answers 200 with text tokens billed and no text. AI Gateway sees a success and passes the empty answer to your app.',
      frames: [
        { at: 'app', tone: 'request' },
        { at: 'gateway', tone: 'request' },
        { at: 'baseten', tone: 'request' },
        { at: 'baseten', tone: 'empty', marks: { baseten: ['200 · no text', 'neutral'] } },
        { at: 'gateway', tone: 'empty', marks: { gateway: ['success', 'neutral'] } },
        { at: 'app', tone: 'empty', marks: { app: ['empty answer', 'bad'] } },
      ],
    },
  },
  {
    title: 'provider-guard Catches Them',
    body: (
      <>
        <p>
          provider-guard wraps your model. It spots the billed-but-empty answer and retries once on
          another provider, in the same stream. It records metadata only, never prompts or
          responses.
        </p>
        <p className="intro-note text-copy-13">
          It also adds <code>exclude()</code>, since a request can't exclude one provider today (
          {issue(20934)}), and flags providers that ignore reasoning effort ({issue(21207)}).
        </p>
      </>
    ),
    diagram: {
      alt: "provider-guard sits between your app and AI Gateway. It catches baseten's empty answer and retries the call on zai, and the answer returns to your app in the same stream.",
      frames: [
        { at: 'app', tone: 'request' },
        { at: 'guard', tone: 'request' },
        { at: 'gateway', tone: 'request' },
        { at: 'baseten', tone: 'request' },
        { at: 'baseten', tone: 'empty', marks: { baseten: ['200 · no text', 'neutral'] } },
        { at: 'gateway', tone: 'empty' },
        { at: 'guard', tone: 'empty', marks: { guard: ['caught', 'bad'] }, flag: true },
        { at: 'gateway', tone: 'request', marks: { gateway: ['retried on zai', 'neutral'] } },
        { at: 'zai', tone: 'request' },
        { at: 'gateway', tone: 'answer' },
        { at: 'guard', tone: 'answer' },
        { at: 'app', tone: 'answer', marks: { app: ['recovered', 'ok'] } },
      ],
    },
  },
  {
    title: 'Reading This Screen',
    body: (
      <p>
        This demo replays calls reconstructed from the data published in those issues. No live
        traffic.
      </p>
    ),
  },
]

/** The frame to draw: advances every FRAME_MS to the last frame, or starts there. */
function usePhase(count: number, reduced: boolean): number {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    if (reduced) return
    const tick = setInterval(() => setPhase((p) => Math.min(p + 1, count - 1)), FRAME_MS)
    const stop = setTimeout(() => clearInterval(tick), FRAME_MS * count)
    return () => {
      clearInterval(tick)
      clearTimeout(stop)
    }
  }, [count, reduced])
  return reduced ? count - 1 : phase
}

function Box({ id, label, width }: { id: NodeId; label: string; width: number }) {
  const [x, y] = POS[id]
  const height = id === 'guard' ? 28 : 32
  return (
    <g className={`flow-node flow-node-${id}`}>
      <rect x={x - width / 2} y={y - height / 2} width={width} height={height} rx={8} />
      <text x={x} y={y} dominantBaseline="central">
        {label}
      </text>
    </g>
  )
}

function Chip({ id, flagged }: { id: NodeId; flagged: boolean }) {
  const [x, y] = POS[id]
  return (
    <g className={`flow-chip${flagged ? ' flow-chip-flagged' : ''}`}>
      <rect x={x - 42} y={y - 13} width={84} height={26} rx={13} />
      {flagged && (
        <g className="flow-flag" transform={`translate(${x - 35} ${y - 6}) scale(0.75)`}>
          <path d="M3.5 14.25V1.75" />
          <path d="M3.5 2.25h8.75L10.25 5.5l2 3.25H3.5" />
        </g>
      )}
      <text x={flagged ? x + 6 : x} y={y} dominantBaseline="central">
        {id}
      </text>
    </g>
  )
}

function FlowDiagram({ diagram }: { diagram: Diagram }) {
  const reduced = useReducedMotion()
  const phase = usePhase(diagram.frames.length, reduced)
  const shown = diagram.frames.slice(0, phase + 1)
  const frame = shown[shown.length - 1] ?? diagram.frames[0]
  const marks: Partial<Record<NodeId, Mark>> = Object.assign({}, ...shown.map((f) => f.marks))
  const flagged = shown.some((f) => f.flag)
  const guarded = diagram.frames.some((f) => f.at === 'guard')
  const [px, py] = POS[frame?.at ?? 'app']
  return (
    <svg className="flow-svg" viewBox="0 0 380 176" role="img" aria-label={diagram.alt}>
      <g className="flow-lines">
        <line x1={POS.app[0]} y1={POS.app[1]} x2={POS.gateway[0]} y2={POS.gateway[1]} />
        {PROVIDERS.map((p) => (
          <line key={p} x1={POS.gateway[0]} y1={POS.gateway[1]} x2={POS[p][0]} y2={POS[p][1]} />
        ))}
      </g>
      {/* Under the nodes: the call shows while it travels and hides while a node handles it. */}
      <circle
        className={`flow-packet flow-${frame?.tone ?? 'request'}`}
        r={5}
        style={{ transform: `translate(${px}px, ${py}px)` }}
      />
      <Box id="app" label="Your app" width={76} />
      {guarded && <Box id="guard" label="guard()" width={68} />}
      <Box id="gateway" label="AI Gateway" width={88} />
      {PROVIDERS.map((p) => (
        <Chip key={p} id={p} flagged={flagged && p === 'baseten'} />
      ))}
      {Object.entries(marks).map(([id, mark]) => {
        if (!mark) return null
        const [x, y] = MARK_POS[id as NodeId]
        return (
          <text key={`${id}-${mark[0]}`} className={`flow-mark flow-mark-${mark[1]}`} x={x} y={y}>
            {mark[0]}
          </text>
        )
      })}
    </svg>
  )
}

function Flow({ diagram }: { diagram: Diagram }) {
  const [run, setRun] = useState(0)
  return (
    <figure className="flow">
      {/* Keyed by run: Play Again redraws from the first frame instead of sliding back. */}
      <FlowDiagram key={run} diagram={diagram} />
      <Button
        className="flow-replay"
        variant="tertiary"
        size="tiny"
        prefix={<IconRestart size={14} />}
        onClick={() => setRun((r) => r + 1)}
      >
        Play Again
      </Button>
    </figure>
  )
}

function Legend({ sample }: { sample: Call | null }) {
  const reduced = useReducedMotion()
  return (
    <>
      {sample && (
        // The Feed's own chips and result, playing the Feed's catch animation once.
        <div className={`intro-sample${reduced ? '' : ' catching'}`}>
          <ProviderPath call={sample} />
          <ResultLabel call={sample} />
        </div>
      )}
      <dl className="intro-legend text-copy-13">
        <dt>Red flag</dt>
        <dd>The provider that billed tokens and sent nothing.</dd>
        <dt>Arrow</dt>
        <dd>The provider the call was retried on.</dd>
        <dt>Result</dt>
        <dd>What your app received. Healthy calls show a quiet check.</dd>
      </dl>
      <ul className="intro-points">
        <li>
          Click a call to open Call anatomy: both attempts on one timeline, and the checks that
          caught it.
        </li>
        <li>
          Providers compares empty rates for each model and flags outliers like Baseten, and effort
          that is ignored, like on Bedrock.
        </li>
      </ul>
    </>
  )
}

export function Intro({ sample, onClose }: { sample: Call | null; onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const step = STEPS[index] ?? STEPS[0]
  const last = index === STEPS.length - 1
  const back = () => {
    setIndex(index - 1)
    // Back is disabled on the first step; keep focus on the panel's main action.
    if (index === 1) document.querySelector<HTMLElement>('.intro-footer [data-autofocus]')?.focus()
  }
  return (
    <div className="intro">
      <header className="intro-header">
        <div className="intro-title-row">
          <h2 id="intro-title" className="text-heading-20">
            How It Works
          </h2>
          <Button svgOnly variant="tertiary" aria-label="Close" onClick={onClose}>
            <IconX />
          </Button>
        </div>
        <p className="intro-subtitle text-copy-14">
          Why provider-guard exists, and how to read this demo.
        </p>
      </header>
      <section className="intro-step text-copy-14" aria-live="polite" aria-labelledby="intro-step">
        <h3 id="intro-step" className="text-heading-16">
          {step?.title}
        </h3>
        {step?.body}
        {step?.diagram && <Flow key={index} diagram={step.diagram} />}
        {last && <Legend sample={sample} />}
      </section>
      <footer className="intro-footer">
        <span className="intro-count text-label-13">
          {index + 1} of {STEPS.length}
        </span>
        <Button disabled={index === 0} onClick={back}>
          Back
        </Button>
        <Button
          variant="default"
          data-autofocus
          onClick={last ? onClose : () => setIndex(index + 1)}
        >
          {last ? 'Done' : 'Next'}
        </Button>
      </footer>
    </div>
  )
}
