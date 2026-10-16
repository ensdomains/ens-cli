import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'incur'
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  toHex,
  zeroAddress,
} from 'viem'
import { namehash, packetToBytes } from 'viem/ens'
import { addresses } from '../src/lib/contracts.ts'

// Mock RPC responses to exercise CLI routing and error handling.
const deployedAbi = parseAbi([
  'function isENSv2() view returns (bool)',
  'function ROOT_REGISTRY() view returns (address)',
  'function ETH_REGISTRY() view returns (address)',
  'function getSubregistry(string label) view returns (address)',
  'function getState(uint256 id) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function supportsInterface(bytes4 id) view returns (bool)',
  'function rentPrice(string label, uint256 duration) view returns ((uint256 base, uint256 premium))',
  'function getRenewPrice(string label, uint64 duration, address token) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function setText(bytes name, string key, string value)',
  'function renew((string label, uint64 duration, bytes32 referrer) data, address paymentToken)',
])
const legacyAbi = parseAbi([
  'function setText(bytes32 node, string key, string value)',
  'function renew(string label, uint256 duration, bytes32 referrer) payable',
])
const hex = z.custom<`0x${string}`>(
  (value) => typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value),
)
const callSchema = z.tuple([z.object({ to: hex, data: hex }), z.string()])
const owner = '0x0000000000000000000000000000000000000001'
const root = '0x9703DBD26dAB89504490994138cF2c575251a9cE'
const v2 = addresses.sepolia.v2
let active = true
let modernResolver = true
let state = 1
let latestOwner: `0x${string}` = zeroAddress
let rpcFailure = false
let contractFailure = false
let oldResolver = false
let wrongRegistry = false
let ethRegistry: `0x${string}` = '0x0000000000000000000000000000000000000002'
let calls: { to: string; name: string }[] = []

mock.module('../src/lib/client.ts', () => ({
  createEnsClient: () =>
    createPublicClient({
      transport: custom(
        {
          request: async ({ method, params }) => {
            if (rpcFailure) throw new Error('RPC connection failed')
            if (contractFailure) throw Object.assign(new Error('execution reverted'), { code: 3 })
            if (method === 'eth_getCode') return '0x'
            if (method !== 'eth_call') throw new Error(`Unexpected method ${method}`)
            const [call] = callSchema.parse(params)
            const decoded = decodeFunctionData({ abi: deployedAbi, data: call.data })
            calls.push({ to: call.to.toLowerCase(), name: decoded.functionName })
            switch (decoded.functionName) {
              case 'isENSv2':
                if (oldResolver) throw new Error('Legacy UR has no isENSv2 method')
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'isENSv2',
                  result: active,
                })
              case 'ROOT_REGISTRY':
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'ROOT_REGISTRY',
                  result: root,
                })
              case 'getSubregistry':
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'getSubregistry',
                  result:
                    decoded.args[0] === 'eth' ? (wrongRegistry ? owner : ethRegistry) : zeroAddress,
                })
              case 'ETH_REGISTRY':
                expect(call.to.toLowerCase()).toBe(v2.registrar.toLowerCase())
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'ETH_REGISTRY',
                  result: ethRegistry,
                })
              case 'getState':
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'getState',
                  result: {
                    status: state,
                    expiry: 2000000000n,
                    latestOwner,
                    tokenId: 1n,
                    resource: 0n,
                  },
                })
              case 'supportsInterface':
                // Solidity: INormalizedUniversalResolver and IAddressSetter.
                expect(decoded.args[0]).toBe(
                  call.to.toLowerCase() === addresses.sepolia.universalResolver.toLowerCase()
                    ? '0xfe0badd6'
                    : '0xb4436dde',
                )
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'supportsInterface',
                  result: decoded.args[0] === '0xfe0badd6' ? !oldResolver : modernResolver,
                })
              case 'getRenewPrice':
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'getRenewPrice',
                  result: 1000n,
                })
              case 'rentPrice':
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'rentPrice',
                  result: { base: 1000n, premium: 500n },
                })
              case 'symbol':
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'symbol',
                  result: 'USDC',
                })
              case 'decimals':
                return encodeFunctionResult({
                  abi: deployedAbi,
                  functionName: 'decimals',
                  result: 6,
                })
              default:
                throw new Error(`Unexpected function ${decoded.functionName}`)
            }
          },
        },
        { retryCount: 0 },
      ),
    }),
}))

const { cli } = await import('../src/cli.ts')
const { isV2Active, activeV2Deployment } = await import('../src/lib/context.ts')
const { supportsV2RecordSetters } = await import('../src/lib/records.ts')
const { createEnsClient } = await import('../src/lib/client.ts')
const transactionSchema = z.object({ to: hex, data: hex, value: z.string() })

async function run(args: string[]) {
  let output = ''
  let exitCode = 0
  await cli.serve([...args, '--chain', 'sepolia', '--format', 'json'], {
    env: {},
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      exitCode = code
    },
  })
  return { exitCode, output, json: (): unknown => JSON.parse(output) }
}

beforeEach(() => {
  active = true
  modernResolver = true
  state = 1
  latestOwner = zeroAddress
  rpcFailure = false
  contractFailure = false
  oldResolver = false
  wrongRegistry = false
  ethRegistry = '0x0000000000000000000000000000000000000002'
  calls = []
})

describe('contract routing', () => {
  test('detects v2 through the selected UR and discovers its eth registry', async () => {
    expect(await activeV2Deployment({ options: { chain: 'sepolia' }, env: {} })).toEqual({
      ...v2,
      registry: ethRegistry,
    })
    expect(calls).toContainEqual({ to: root.toLowerCase(), name: 'getSubregistry' })
    ethRegistry = '0x0000000000000000000000000000000000000003'
    expect((await activeV2Deployment({ options: { chain: 'sepolia' }, env: {} }))?.registry).toBe(
      ethRegistry,
    )
    wrongRegistry = true
    await expect(activeV2Deployment({ options: { chain: 'sepolia' }, env: {} })).rejects.toThrow(
      'does not match',
    )
  })

  test('detects legacy v1 without masking RPC failures or contract reverts', async () => {
    oldResolver = true
    expect(await isV2Active({ options: {}, env: {} })).toEqual({ isV2: false })
    rpcFailure = true
    await expect(isV2Active({ options: {}, env: {} })).rejects.toThrow('RPC connection failed')
    await expect(supportsV2RecordSetters(createEnsClient({}), owner)).rejects.toThrow(
      'RPC connection failed',
    )
    rpcFailure = false
    contractFailure = true
    await expect(isV2Active({ options: {}, env: {} })).rejects.toThrow('execution reverted')
    await expect(supportsV2RecordSetters(createEnsClient({}), owner)).rejects.toThrow(
      'execution reverted',
    )
  })

  test('record writes select the target resolver ABI even on the same chain', async () => {
    for (const modern of [true, false]) {
      modernResolver = modern
      const result = await run([
        'set',
        'text',
        'test.eth',
        '--resolver',
        owner,
        '--key',
        'url',
        '--value',
        'example',
      ])
      expect(result.exitCode).toBe(0)
      const data = transactionSchema.parse(result.json()).data
      const decoded = decodeFunctionData({ abi: modern ? deployedAbi : legacyAbi, data })
      expect(decoded.args?.[0]).toBe(
        modern ? toHex(packetToBytes('test.eth')) : namehash('test.eth'),
      )
    }
  })

  test.each([
    { status: 1, lastOwner: zeroAddress, expected: v2.renewerV1 },
    { status: 2, lastOwner: owner, expected: v2.registrar },
    { status: 0, lastOwner: zeroAddress, expected: v2.renewerV1 },
    { status: 0, lastOwner: owner, expected: v2.registrar },
  ])(
    'renewal routes $status/$lastOwner to $expected, including expired names',
    async ({ status, lastOwner, expected }) => {
      state = status
      latestOwner = lastOwner
      const result = await run(['renew', 'test.eth'])
      expect(result.exitCode).toBe(0)
      const tx = transactionSchema.parse(result.json())
      expect(tx.to).toBe(expected)
      expect(tx.value).toBe('0')
      const price = await run(['price', 'test.eth', '--renew'])
      expect(price.exitCode).toBe(0)
      expect(calls).toContainEqual({ to: expected.toLowerCase(), name: 'getRenewPrice' })
      expect(calls.some((call) => call.name === 'getRegisterPrice')).toBe(false)
      expect(z.object({ total: z.string() }).parse(price.json()).total).toBe('1000')
    },
  )

  test('v1 renewal quote excludes the registration premium', async () => {
    active = false
    const quote = z.object({ base: z.string(), premium: z.string(), total: z.string() })
    expect(quote.parse((await run(['price', 'test.eth'])).json())).toEqual({
      base: '1000',
      premium: '500',
      total: '1500',
    })
    expect(quote.parse((await run(['price', 'test.eth', '--renew'])).json())).toEqual({
      base: '1000',
      premium: '0',
      total: '1000',
    })
  })

  test('rejects ETH on v2 renewal and requires it on v1 renewal', async () => {
    expect((await run(['renew', 'test.eth', '--value', '1'])).output).toContain('Do not send ETH')
    active = false
    expect((await run(['renew', 'test.eth'])).output).toContain('ENSv1 renewal requires --value')
    const result = await run(['renew', 'test.eth', '--value', '1000'])
    const tx = transactionSchema.parse(result.json())
    expect(tx.to).toBe(addresses.sepolia.controller)
    expect(tx.value).toBe('1000')
    expect(decodeFunctionData({ abi: legacyAbi, data: tx.data }).functionName).toBe('renew')
  })
})
