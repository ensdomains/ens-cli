import { z } from 'incur'
import {
  AbiDecodingZeroDataError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  zeroAddress,
} from 'viem'
import { labelhash } from 'viem/ens'
import { createEnsClient } from './client.ts'
import { addresses, universalResolverAbi, v2RegistryAbi, type Chain } from './contracts.ts'
import { eth2ldLabelForName } from './utils.ts'
import { V2_STATUS_REGISTERED } from './v2.ts'

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

/** Contract-level probe failures mean the UR lacks v2; transport/RPC errors must propagate. */
function isV2ProbeContractFailure(err: unknown): boolean {
  if (!(err instanceof Error) || !('walk' in err)) return false
  const walkable = err as Error & { walk: (fn: (e: Error) => boolean) => Error | undefined }
  return !!walkable.walk(
    (e) =>
      e instanceof ContractFunctionRevertedError ||
      e instanceof ContractFunctionZeroDataError ||
      e instanceof AbiDecodingZeroDataError,
  )
}

// Switch to help with logic around ENSv2.
// Without a name, check whether the UR supports v2. With a name, also require
// its anchoring .eth 2LD to be registered (rather than only reserved) in v2.
export async function isV2Active(c: Context, name?: string) {
  const { client, chain } = clientFromContext(c)

  let ethRegistry: `0x${string}`
  try {
    ethRegistry = await client.readContract({
      address: universalResolverAddress(c, chain),
      abi: universalResolverAbi,
      functionName: 'findCanonicalRegistry',
      args: ['0x0365746800'],
    })
  } catch (err) {
    if (isV2ProbeContractFailure(err)) return { isV2: false } as const
    throw err
  }

  if (ethRegistry === zeroAddress) return { isV2: false } as const

  if (name != null) {
    const label = eth2ldLabelForName(name)
    if (label == null) return { isV2: false } as const

    const { status } = await client.readContract({
      address: ethRegistry,
      abi: v2RegistryAbi,
      functionName: 'getState',
      args: [BigInt(labelhash(label))],
    })
    if (status !== V2_STATUS_REGISTERED) return { isV2: false } as const
  }

  return { isV2: true, ethRegistry } as const
}

export async function activeV2Deployment(c: Context, name?: string) {
  const { isV2 } = await isV2Active(c, name)
  if (!isV2) return undefined
  return v2DeploymentForChain(c.options.chain ?? 'mainnet')
}

export function v2DeploymentForChain(chain: Chain) {
  const chainAddresses = addresses[chain]
  return 'v2' in chainAddresses ? chainAddresses.v2 : undefined
}
