// Lanczos approximation of ln Γ(x) (g = 7, n = 9); ~15 significant digits.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
]

export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  const z = x - 1
  let sum = LANCZOS[0] as number
  for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] as number) / (z + i)
  const t = z + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
}

const logChoose = (n: number, k: number) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)

/**
 * One-sided Fisher exact test on the 2×2 table [[a, b], [c, d]] (alternative: greater):
 * the probability of `a` or more in the top-left cell with all margins fixed.
 * Here: a = empty calls on one provider, b = its other calls, c/d = the same for all others.
 */
export function fisherExactGreater(a: number, b: number, c: number, d: number): number {
  const row = a + b
  const col = a + c
  const n = row + c + d
  const denominator = logChoose(n, col)
  let p = 0
  for (let k = a; k <= Math.min(row, col); k++) {
    p += Math.exp(logChoose(row, k) + logChoose(n - row, col - k) - denominator)
  }
  return Math.min(1, p)
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  const mid = sorted.length >> 1
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
