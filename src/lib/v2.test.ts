import { describe, expect, test } from 'bun:test'
import { addresses } from './contracts.ts'
import {
  ALL_ROLES,
  V2_DEFAULT_OWNER_ROLE_BITMAP,
  assertV2EthName,
  computeOwnedResolverAddress,
  defaultOwnedResolverSalt,
  defaultUserRegistrySalt,
  splitSubname,
} from './v2.ts'

const FIXED_OWNER = '0x0000000000000000000000000000000000000001' as const

describe('splitSubname', () => {
  test('splits label and parent', () => {
    expect(splitSubname('sub.parent.eth')).toEqual({
      label: 'sub',
      parent: 'parent.eth',
    })
  })

  test('rejects bare TLD, leading dot, and trailing dot', () => {
    expect(() => splitSubname('eth')).toThrow('not a subname')
    expect(() => splitSubname('.eth')).toThrow('not a subname')
    expect(() => splitSubname('name.')).toThrow('not a subname')
  })
})

describe('assertV2EthName', () => {
  test('accepts names under .eth', () => {
    expect(assertV2EthName('name.eth')).toEqual(['name', 'eth'])
    expect(assertV2EthName('a.b.eth')).toEqual(['a', 'b', 'eth'])
  })

  test('rejects names not under .eth', () => {
    expect(() => assertV2EthName('name.com')).toThrow('only support names under .eth')
  })
})

describe('defaultUserRegistrySalt', () => {
  test('derives a deterministic salt for a fixed name', () => {
    expect(defaultUserRegistrySalt('name.eth').toString()).toBe(
      '49113713552329534562729767047651278669747647218699622453906455990860682367225',
    )
  })
})

describe('defaultOwnedResolverSalt', () => {
  test('derives a deterministic salt for a fixed owner', () => {
    expect(defaultOwnedResolverSalt(FIXED_OWNER).toString()).toBe(
      '4584221722592246109917782315393567699097774086745760521286189100586804932025',
    )
  })
})

describe('computeOwnedResolverAddress', () => {
  test('derives CREATE2 address and outerSalt for Sepolia factory inputs', () => {
    const result = computeOwnedResolverAddress({
      factory: addresses.sepolia.v2.resolverFactory,
      proxyLogic: addresses.sepolia.v2.resolverProxyLogic,
      deployer: FIXED_OWNER,
      owner: FIXED_OWNER,
    })

    expect(result.address).toBe('0x0cD4E0a7cDF1F7B994C70fcA4a15454BBBf8a711')
    expect(result.salt.toString()).toBe(
      '4584221722592246109917782315393567699097774086745760521286189100586804932025',
    )
    expect(result.outerSalt).toBe(
      '0x1651ea7c817915fb3b6879875d43db41e915b8cf612d82ad0e2111d8bcc9db86',
    )
  })
})

describe('role bitmap constants', () => {
  test('V2_DEFAULT_OWNER_ROLE_BITMAP matches expected value', () => {
    expect(V2_DEFAULT_OWNER_ROLE_BITMAP.toString()).toBe(
      '6089497235773768281585597070825043213744672768',
    )
  })

  test('ALL_ROLES matches expected value', () => {
    expect(ALL_ROLES.toString()).toBe(
      '7719472615821079694904732333912527190217998977709370935963838933860875309329',
    )
  })
})
