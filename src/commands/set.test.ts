import { describe, expect, test } from 'bun:test'
import { decodeFunctionData } from 'viem/utils'
import { namehash } from 'viem/ens'
import { publicResolverAbi } from '../lib/contracts.ts'
import { batchOperationSchema, encodeSetAddr, encodeSetContenthash, encodeSetText } from './set.ts'

const NODE = namehash('test.eth')
const ADDRESS = '0x0000000000000000000000000000000000000001'

describe('encodeSetAddr', () => {
  test('encodes setAddr(bytes32,address) without coinType', () => {
    const data = encodeSetAddr(NODE, ADDRESS)
    expect(data.slice(0, 10)).toBe('0xd5fa2b00')

    const decoded = decodeFunctionData({ abi: publicResolverAbi, data })
    expect(decoded.functionName).toBe('setAddr')
    expect(decoded.args).toEqual([NODE, ADDRESS])
  })

  test('encodes setAddr(bytes32,uint256,bytes) with coinType', () => {
    const data = encodeSetAddr(NODE, ADDRESS, 2147483658)
    expect(data.slice(0, 10)).toBe('0x8b95dd71')

    const decoded = decodeFunctionData({ abi: publicResolverAbi, data })
    expect(decoded.functionName).toBe('setAddr')
    expect(decoded.args).toEqual([NODE, 2147483658n, ADDRESS])
  })
})

describe('encodeSetText', () => {
  test('encodes setText and decodes round-trip', () => {
    const data = encodeSetText(NODE, 'url', 'https://example.com')
    expect(data.slice(0, 10)).toBe('0x10f13a8c')

    const decoded = decodeFunctionData({ abi: publicResolverAbi, data })
    expect(decoded.functionName).toBe('setText')
    expect(decoded.args).toEqual([NODE, 'url', 'https://example.com'])
  })
})

describe('encodeSetContenthash', () => {
  test('encodes setContenthash and decodes round-trip', () => {
    const hash = '0x1234abcd'
    const data = encodeSetContenthash(NODE, hash)
    expect(data.slice(0, 10)).toBe('0x304e6ade')

    const decoded = decodeFunctionData({ abi: publicResolverAbi, data })
    expect(decoded.functionName).toBe('setContenthash')
    expect(decoded.args).toEqual([NODE, hash])
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
