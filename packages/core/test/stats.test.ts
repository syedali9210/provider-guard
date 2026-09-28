import { describe, expect, test } from 'vitest'
import { fisherExactGreater, logGamma, median } from '../src/stats'

/** Exact one-sided p as a rational number, computed with BigInt, as an independent oracle. */
function exactGreater(a: number, b: number, c: number, d: number): number {
  const choose = (n: number, k: number) => {
    let r = 1n
    for (let i = 1; i <= k; i++) r = (r * BigInt(n - k + i)) / BigInt(i)
    return r
  }
  const row = a + b
  const col = a + c
  const n = row + c + d
  let numerator = 0n
  for (let k = a; k <= Math.min(row, col); k++) {
    numerator += choose(row, k) * choose(n - row, col - k)
  }
  // Scale so the integer quotient keeps ~20 significant digits whatever the magnitude.
  const denominator = choose(n, col)
  const shift = denominator.toString().length - numerator.toString().length + 20
  return Number((numerator * 10n ** BigInt(shift)) / denominator) * 10 ** -shift
}

describe('fisherExactGreater', () => {
  test("Fisher's tea-tasting table gives 17/70", () => {
    expect(fisherExactGreater(3, 1, 1, 3)).toBeCloseTo(17 / 70, 12)
  })

  test('a perfectly separated table gives 1 / C(20, 10)', () => {
    expect(fisherExactGreater(10, 0, 0, 10)).toBeCloseTo(1 / 184756, 15)
  })

  test('no events on the provider gives p = 1', () => {
    expect(fisherExactGreater(0, 10, 0, 10)).toBe(1)
    expect(fisherExactGreater(0, 30, 5, 30)).toBeCloseTo(1, 12)
  })

  test.each([
    // vercel/ai#20932: Baseten 22 empty of 51 vs 0 of 37 elsewhere.
    [22, 29, 0, 37],
    [5, 5, 5, 5],
    [7, 3, 2, 12],
    [1, 99, 0, 100],
    [40, 460, 20, 480],
    [200, 300, 20, 480],
  ])('matches the exact rational value for [[%i, %i], [%i, %i]]', (a, b, c, d) => {
    const exact = exactGreater(a, b, c, d)
    const approx = fisherExactGreater(a, b, c, d)
    expect(Math.abs(approx - exact) / exact).toBeLessThan(1e-9)
  })

  test('the #20932 Baseten table is far below the outlier threshold', () => {
    expect(fisherExactGreater(22, 29, 0, 37)).toBeLessThan(0.0001)
  })
})

test('logGamma matches known factorials and Γ(1/2)', () => {
  expect(logGamma(1)).toBeCloseTo(0, 12)
  expect(logGamma(11)).toBeCloseTo(Math.log(3628800), 10)
  expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12)
  expect(logGamma(0.25)).toBeCloseTo(1.2880225246980774, 12)
})

test('median', () => {
  expect(median([])).toBeNull()
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 3, 2])).toBe(2.5)
  expect(median([1552, 1902, 1750])).toBe(1750)
})
