import { describe, expect, test } from 'bun:test'
import { resolveCoinType } from './cointype.ts'

describe('resolveCoinType', () => {
  test('passes through coinType when set', () => {
    expect(resolveCoinType({ coinType: 60 })).toBe(60)
    expect(resolveCoinType({ coinType: 0 })).toBe(0)
  })

  test('converts chainId to ENSIP-11 coin type', () => {
    expect(resolveCoinType({ chainId: 10 })).toBe(2147483658)
  })

  test('throws when both coinType and chainId are set', () => {
    expect(() => resolveCoinType({ coinType: 60, chainId: 10 })).toThrow(
      'Cannot specify both --coin-type and --chain-id',
    )
  })

  test('returns undefined when neither is set', () => {
    expect(resolveCoinType({})).toBeUndefined()
  })
})
