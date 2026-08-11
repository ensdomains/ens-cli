import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getFunctionSelector } from 'viem'
import { permissionedResolverAbi } from '../lib/contracts.ts'
import { ALL_ROLES } from '../lib/v2.ts'
import { encodePermissionedResolverInitializeData } from './resolver.ts'

describe('PermissionedResolver deployment calldata', () => {
  test('uses the deployed three-argument initializer with no initial setters', () => {
    const admin = '0x0000000000000000000000000000000000000001'
    const data = encodePermissionedResolverInitializeData(admin, ALL_ROLES)

    expect(data.slice(0, 10)).toBe(getFunctionSelector('initialize(address,uint256,bytes[])'))
    expect(data.slice(0, 10)).toBe('0x7058b559')

    expect(decodeFunctionData({ abi: permissionedResolverAbi, data })).toEqual({
      functionName: 'initialize',
      args: [admin, ALL_ROLES, []],
    })
  })
})
