import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { bytesToHex } from 'viem/utils'
import { labelhash, namehash, packetToBytes } from 'viem/ens'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  isV2Active,
  universalResolverAddress,
} from '../lib/context.ts'
import {
  addresses,
  baseRegistrarAbi,
  ensRegistryAbi,
  universalResolverAbi,
  v2RegistryAbi,
} from '../lib/contracts.ts'
import { validateName, eth2ldLabel } from '../lib/utils.ts'

function toNullableAddress(value: `0x${string}`) {
  return value === zeroAddress ? null : value
}

const statusLabels = ['AVAILABLE', 'RESERVED', 'REGISTERED'] as const

function mapStatus(status: number | bigint) {
  return statusLabels[Number(status)] ?? 'UNKNOWN'
}

function formatExpiry(expiry: bigint) {
  if (expiry === 0n) return { expiry: null, expiryDate: null }
  return {
    expiry: expiry.toString(),
    expiryDate: new Date(Number(expiry) * 1000).toISOString(),
  }
}

export const whoisCommand = Cli.create('whois', {
  description: 'Show ENS registry owner, resolver, and .eth expiry for a name',
  args: z.object({
    name: z.string().describe('ENS name to inspect (e.g. vitalik.eth)'),
  }),
  options: globalOptions,
  env: globalEnv,
  async run(c) {
    const { client, chain } = clientFromContext(c)
    const { isV2, ethRegistry } = await isV2Active(c)
    const name = validateName(c.args.name)
    const node = namehash(name)
    const label = eth2ldLabel(name)

    if (isV2) {
      // TODO: handle non-2LD .eth names
      if (label == null) {
        throw new Error(`v2 whois only supports 2LD .eth names for now`)
      }

      const [{ resolver }, { status, expiry, latestOwner, tokenId, resource }] = await Promise.all([
        client.readContract({
          address: universalResolverAddress(c, chain),
          abi: universalResolverAbi,
          functionName: 'findResolver',
          args: [bytesToHex(packetToBytes(name))],
        }),
        client.readContract({
          address: ethRegistry,
          abi: v2RegistryAbi,
          functionName: 'getState',
          args: [BigInt(labelhash(label))],
        }),
      ])

      // ownerOf reverts for nonexistent tokens, so only read it for registered names
      const owner =
        mapStatus(status) === 'REGISTERED'
          ? await client.readContract({
              address: ethRegistry,
              abi: v2RegistryAbi,
              functionName: 'ownerOf',
              args: [tokenId],
            })
          : zeroAddress

      return {
        name,
        owner: toNullableAddress(owner),
        resolver: toNullableAddress(resolver),
        registry: ethRegistry,
        status: mapStatus(status),
        ...formatExpiry(expiry),
        latestOwner: toNullableAddress(latestOwner),
        tokenId: tokenId.toString(),
        resource: resource.toString(),
      }
    }

    const [owner, resolver, expiry] = await Promise.all([
      client.readContract({
        address: addresses[chain].registry,
        abi: ensRegistryAbi,
        functionName: 'owner',
        args: [node],
      }),
      client.readContract({
        address: addresses[chain].registry,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [node],
      }),
      label == null
        ? Promise.resolve(0n)
        : client.readContract({
            address: addresses[chain].baseRegistrar,
            abi: baseRegistrarAbi,
            functionName: 'nameExpires',
            args: [BigInt(labelhash(label))],
          }),
    ])

    return {
      name,
      owner: toNullableAddress(owner),
      resolver: toNullableAddress(resolver),
      ...formatExpiry(expiry),
    }
  },
})
