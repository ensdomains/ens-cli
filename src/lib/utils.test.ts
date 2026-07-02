import { describe, expect, test } from 'bun:test'
import {
  ONE_YEAR,
  asHex,
  durationFromOption,
  eth2ldLabel,
  extractLabel,
  validateName,
} from './utils.ts'

describe('validateName', () => {
  test('normalizes valid names to lowercase', () => {
    expect(validateName('NAME.ETH')).toBe('name.eth')
  })

  test('throws on empty or whitespace-only names', () => {
    expect(() => validateName('')).toThrow('Name cannot be empty.')
    expect(() => validateName('   ')).toThrow('Name cannot be empty.')
  })

  test('throws when name has no dot', () => {
    expect(() => validateName('eth')).toThrow('Expected a fully qualified name')
  })

  test('throws on invalid unicode', () => {
    expect(() => validateName('\uFFFD.eth')).toThrow('Invalid ENS name')
  })
})

describe('eth2ldLabel', () => {
  test('returns label for 2LD .eth names', () => {
    expect(eth2ldLabel('name.eth')).toBe('name')
  })

  test('returns null for subnames and non-.eth names', () => {
    expect(eth2ldLabel('sub.name.eth')).toBeNull()
    expect(eth2ldLabel('name.com')).toBeNull()
  })
})

describe('extractLabel', () => {
  test('returns normalized label for valid 2LDs', () => {
    expect(extractLabel('NAME.ETH')).toBe('name')
  })

  test('rejects non-2LD names', () => {
    expect(() => extractLabel('sub.name.eth')).toThrow('Registration only supports 2LDs')
  })

  test('rejects labels shorter than 3 characters', () => {
    expect(() => extractLabel('ab.eth')).toThrow('at least 3 characters')
  })
})

describe('asHex', () => {
  test('accepts valid hex strings', () => {
    expect(asHex('0x1234', 'value')).toBe('0x1234')
  })

  test('rejects non-hex strings', () => {
    expect(() => asHex('not-hex', 'value')).toThrow('Invalid value')
  })
})

describe('durationFromOption', () => {
  test('defaults to one year', () => {
    expect(durationFromOption(undefined)).toBe(ONE_YEAR)
    expect(durationFromOption(undefined)).toBe(31536000n)
  })

  test('uses provided duration', () => {
    expect(durationFromOption(63072000)).toBe(63072000n)
  })
})
