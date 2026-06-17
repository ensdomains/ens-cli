import { z } from 'incur'
import { createEnsClient } from './client.ts'
import { addresses, universalResolverAbi, type Chain } from './contracts.ts'

export const globalOptions = z.object({
  rpc: z.string().optional().describe('Ethereum RPC URL'),
  chain: z.enum(['mainnet', 'sepolia']).default('mainnet').describe('Chain to use'),
  universalResolver: z.string().optional().describe('Custom Universal Resolver contract address'),
})

export const globalEnv = z.object({
  ETH_RPC_URL: z.string().optional().describe('Ethereum RPC URL (fallback if --rpc not provided)'),
})

export type Context = {
  options: { rpc?: string; chain?: Chain; universalResolver?: string }
  env: { ETH_RPC_URL?: string }
}

export function clientFromContext(c: Context) {
  const chain = c.options.chain ?? 'mainnet'
  const rpc = c.options.rpc ?? c.env.ETH_RPC_URL
  return { client: createEnsClient({ rpc, chain }), chain }
}

export function universalResolverOverride(c: Context): `0x${string}` | undefined {
  return c.options.universalResolver as `0x${string}` | undefined
}

/** Spreadable `universalResolverAddress` param for viem ENS actions. */
export function universalResolverParam(c: Context) {
  const universalResolverAddress = universalResolverOverride(c)
  return universalResolverAddress ? { universalResolverAddress } : {}
}

export function universalResolverAddress(c: Context, chain: Chain): `0x${string}` {
  return universalResolverOverride(c) ?? addresses[chain].universalResolver
}

// Switch to help with logic around ENSv2
// Check if the UR implements `findCanonicalRegistry()`, which only exists in v2
export async function isV2Active(c: Context) {
  const { client, chain } = clientFromContext(c)

  try {
    const ethRegistry = await client.readContract({
      address: universalResolverAddress(c, chain),
      abi: universalResolverAbi,
      functionName: 'findCanonicalRegistry',
      args: ['0x0365746800'],
    })

    return { isV2: true, ethRegistry } as const
  } catch {
    return { isV2: false } as const
  }
}

export async function activeV2Deployment(c: Context) {
  const { isV2 } = await isV2Active(c)
  if (!isV2) return undefined
  return v2DeploymentForChain(c.options.chain ?? 'mainnet')
}

export function v2DeploymentForChain(chain: Chain) {
  const chainAddresses = addresses[chain]
  return 'v2' in chainAddresses ? chainAddresses.v2 : undefined
}
