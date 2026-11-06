import { Cli, z } from 'incur'
import { isAddressEqual, zeroAddress } from 'viem'
import { bytesToHex } from 'viem/utils'
import { labelhash, namehash, packetToBytes } from 'viem/ens'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  settled,
  universalResolverAddress,
  v2RootRegistry,
} from '../lib/context.ts'
import {
  addresses,
  baseRegistrarAbi,
  ensRegistryAbi,
  nameWrapperAbi,
  universalResolverAbi,
} from '../lib/contracts.ts'
import { validateName, eth2ldLabel } from '../lib/utils.ts'
import { V2Status, findV2Entry, isV1Bridge } from '../lib/v2.ts'

function toNullableAddress(value: `0x${string}`) {
  return value === zeroAddress ? null : value
}

function mapStatus(status: number | bigint) {
  return V2Status[Number(status)] ?? 'UNKNOWN'
}

function formatExpiry(expiry: bigint) {
  if (expiry === 0n) return { expiry: null, expiryDate: null }
  return {
    expiry,
    expiryDate: new Date(Number(expiry) * 1000).toISOString(),
  }
}

export const whoisCommand = Cli.create('whois', {
  description:
    'Show the owner, resolver, and expiry of any ENS name (.eth names, subnames, and DNS names), following ENSv2 resolution',
  args: z.object({
    name: z
      .string()
      .describe('ENS name to inspect (e.g. vitalik.eth, sub.nick.eth, or ens.domains)'),
  }),
  options: globalOptions,
  env: globalEnv,
  async run(c) {
    const { client, chain } = clientFromContext(c)
    const name = validateName(c.args.name)
    const node = namehash(name)
    const label = eth2ldLabel(name)
    const v1 = addresses[chain]

    // Start every read that doesn't depend on another so they share one JSON-RPC batch.
    // Only the reads for the version that owns the name count, so the rest may fail.
    const [root, found, v1Owner, v1Resolver, wrapperData, registrarExpiry] =
      await Promise.allSettled([
        v2RootRegistry(c),
        client.readContract({
          address: universalResolverAddress(c, chain),
          abi: universalResolverAbi,
          functionName: 'findResolver',
          args: [bytesToHex(packetToBytes(name))],
        }),
        client.readContract({
          address: v1.registry,
          abi: ensRegistryAbi,
          functionName: 'owner',
          args: [node],
        }),
        client.readContract({
          address: v1.registry,
          abi: ensRegistryAbi,
          functionName: 'resolver',
          args: [node],
        }),
        client.readContract({
          address: v1.nameWrapper,
          abi: nameWrapperAbi,
          functionName: 'getData',
          args: [BigInt(node)],
        }),
        label == null
          ? Promise.resolve(0n)
          : client.readContract({
              address: v1.baseRegistrar,
              abi: baseRegistrarAbi,
              functionName: 'nameExpires',
              args: [BigInt(labelhash(label))],
            }),
      ])

    const rootRegistry = settled(root)
    if (rootRegistry) {
      // ENSv2 resolution hands unmigrated names, DNS names, and other v1 subtrees to a bridge
      // resolver that reads ENSv1; those names are still owned in ENSv1.
      const [resolver] = settled(found)
      const [bridged, entry] = await Promise.all([
        isV1Bridge({ client, resolver, registryV1: v1.registry }),
        findV2Entry({ client, rootRegistry, name }),
      ])

      if (!bridged) {
        const { state } = entry
        return {
          name,
          kind: 'v2',
          owner: entry.owner,
          resolver: toNullableAddress(resolver),
          registry: entry.registry,
          // A name missing from its parent's subregistry is unregistered.
          status: state ? mapStatus(state.status) : entry.registry ? null : 'AVAILABLE',
          ...formatExpiry(state?.expiry ?? 0n),
          latestOwner: state ? toNullableAddress(state.latestOwner) : null,
          tokenId: state?.tokenId ?? null,
          resource: state?.resource ?? null,
        }
      }
    }

    // Wrapped names are owned by the NameWrapper in the registry; report its owner and expiry.
    // Unwrapped names keep stale NameWrapper data, so only read it when the wrapper owns the node.
    const registryOwner = settled(v1Owner)
    const wrapped = isAddressEqual(registryOwner, v1.nameWrapper)
    const [wrappedOwner, fuses, wrappedExpiry] = wrapped ? settled(wrapperData) : []

    return {
      name,
      kind: 'v1',
      owner: toNullableAddress(wrappedOwner ?? registryOwner),
      resolver: toNullableAddress(settled(v1Resolver)),
      wrapped,
      fuses: fuses ?? null,
      ...formatExpiry(wrappedExpiry ?? settled(registrarExpiry)),
    }
  },
})
