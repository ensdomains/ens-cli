import { describe, expect, test } from 'bun:test'
import { decodeFunctionData } from 'viem/utils'
import { namehash } from 'viem/ens'
import { publicResolverAbi } from '../lib/contracts.ts'
import { batchOperationSchema, encodeSetAddr } from './set.ts'

const NODE = namehash('test.eth')
const ADDRESS = '0x0000000000000000000000000000000000000001'

describe('encodeSetAddr', () => {
  test('selects setAddr(bytes32,address) overload when coinType is absent', () => {
    const decoded = decodeFunctionData({
      abi: publicResolverAbi,
      data: encodeSetAddr(NODE, ADDRESS),
    })
    expect(decoded.functionName).toBe('setAddr')
    expect(decoded.args).toEqual([NODE, ADDRESS])
  })

  test('selects setAddr(bytes32,uint256,bytes) overload when coinType is set', () => {
    const decoded = decodeFunctionData({
      abi: publicResolverAbi,
      data: encodeSetAddr(NODE, ADDRESS, 2147483658),
    })
    expect(decoded.functionName).toBe('setAddr')
    expect(decoded.args).toEqual([NODE, 2147483658n, ADDRESS])
  })
})

describe('batchOperationSchema', () => {
  test('accepts documented operation shapes', () => {
    expect(
      batchOperationSchema.parse({
        type: 'address',
        address: ADDRESS,
      }),
    ).toEqual({ type: 'address', address: ADDRESS })

    expect(
      batchOperationSchema.parse({
        type: 'address',
        address: ADDRESS,
        chainId: 10,
      }),
    ).toEqual({ type: 'address', address: ADDRESS, chainId: 10 })

    expect(
      batchOperationSchema.parse({
        type: 'text',
        key: 'url',
        value: 'https://example.com',
      }),
    ).toEqual({ type: 'text', key: 'url', value: 'https://example.com' })

    expect(
      batchOperationSchema.parse({
        type: 'contenthash',
        hash: '0x1234',
      }),
    ).toEqual({ type: 'contenthash', hash: '0x1234' })
  })

  test('rejects unknown operation types', () => {
    expect(() =>
      batchOperationSchema.parse({
        type: 'unknown',
        value: 'x',
      }),
    ).toThrow()
  })
})
