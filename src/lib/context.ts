import { z } from 'incur'
import { isAddressEqual, zeroAddress, type ContractFunctionReturnType } from 'viem'
import { labelhash } from 'viem/ens'
import { createEnsClient } from './client.ts'
import { addresses, universalResolverAbi, v2RegistryAbi, type Chain } from './contracts.ts'
import { eth2ldLabelForName } from './utils.ts'
import { V2Status } from './v2.ts'

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

// Switch to help with logic around ENSv2.
// Without a name, check whether the UR supports v2. With a name, also require
// its anchoring .eth 2LD to be registered or previously registered in v2.
const UNIVERSAL_RESOLVER_V2_INTERFACE_ID = '0xf99a5e06'
type V2RegistryState = ContractFunctionReturnType<typeof v2RegistryAbi, 'view', 'getState'>

type V2Inactive = { readonly isV2: false }
type V2Active = { readonly isV2: true; readonly ethRegistry: `0x${string}` }
type V2NameActive = V2Active & { readonly nameState: V2RegistryState }

export function isV2Active(c: Context): Promise<V2Active | V2Inactive>
export function isV2Active(c: Context, name: string): Promise<V2NameActive | V2Inactive>
export async function isV2Active(c: Context, name?: string) {
  const { client, chain } = clientFromContext(c)
  const resolver = universalResolverAddress(c, chain)

  const supportsV2 = await client.readContract({
    address: resolver,
    abi: universalResolverAbi,
    functionName: 'supportsInterface',
    args: [UNIVERSAL_RESOLVER_V2_INTERFACE_ID],
  })
  if (!supportsV2) return { isV2: false } as const

  const ethRegistry = await client.readContract({
    address: resolver,
    abi: universalResolverAbi,
    functionName: 'findCanonicalRegistry',
    args: ['0x0365746800'],
  })
  if (ethRegistry === zeroAddress) throw new Error('ENSv2 Universal Resolver has no .eth registry')

  if (name != null) {
    const label = eth2ldLabelForName(name)
    if (label == null) return { isV2: false } as const

    const nameState = await client.readContract({
      address: ethRegistry,
      abi: v2RegistryAbi,
      functionName: 'getState',
      args: [BigInt(labelhash(label))],
    })
    // Natural expiry preserves latestOwner; explicit unregister instead bumps the
    // token version stored in the low 32 bits. Either indicates prior v2 ownership.
    const hasRegistrationHistory = (nameState.tokenId & 0xffff_ffffn) !== 0n
    const migrated =
      nameState.status === V2Status.REGISTERED ||
      (nameState.status === V2Status.AVAILABLE &&
        (nameState.latestOwner !== zeroAddress || hasRegistrationHistory))
    if (!migrated) return { isV2: false } as const

    return { isV2: true, ethRegistry, nameState } as const
  }

  return { isV2: true, ethRegistry } as const
}

function configuredV2Deployment(c: Context, ethRegistry: `0x${string}`) {
  const deployment = v2DeploymentForChain(c.options.chain ?? 'mainnet')
  if (!deployment) {
    throw new Error(
      `ENSv2 deployment is not configured for chain "${c.options.chain ?? 'mainnet'}"`,
    )
  }
  if (!isAddressEqual(deployment.registry, ethRegistry)) {
    throw new Error(
      `Configured ENSv2 registry ${deployment.registry} does not match Universal Resolver registry ${ethRegistry}`,
    )
  }
  return deployment
}

export async function activeV2Deployment(c: Context) {
  const v2 = await isV2Active(c)
  return v2.isV2 ? configuredV2Deployment(c, v2.ethRegistry) : undefined
}

export async function activeV2Name(c: Context, name: string) {
  const v2 = await isV2Active(c, name)
  if (!v2.isV2) return undefined
  return { ...v2, deployment: configuredV2Deployment(c, v2.ethRegistry) }
}

export function v2DeploymentForChain(chain: Chain) {
  const chainAddresses = addresses[chain]
  return 'v2' in chainAddresses ? chainAddresses.v2 : undefined
}
