import { expect, test } from 'vitest'
import { VERSION } from '../src/index'

test('placeholder', () => {
  expect(VERSION).toBe('0.0.0')
})
