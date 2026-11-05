import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { encodeFunctionData, getAddress, parseAbi, toHex } from 'viem/utils'
import { getEnsResolver, namehash, packetToBytes } from 'viem/ens'
import { eth2ldLabel, validateName } from '../lib/utils.ts'
import {
  addresses,
  compositeResolverAbi,
  ensRegistryAbi,
  publicResolverAbi,
  reverseRegistrarAbi,
} from '../lib/contracts.ts'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  isV2Active,
  universalResolverParam,
  type Context,
} from '../lib/context.ts'
import { V2Status } from '../lib/v2.ts'
import { coinTypeOptions, resolveCoinType } from '../lib/cointype.ts'
import {
  encodeRecordOperation,
  encodeV2RecordOperation,
  supportsV2RecordSetters,
  isUnsupportedCall,
  parseRecordOperations,
  type RecordOperation,
} from '../lib/records.ts'

type SetContext = Context & { options: { resolver?: string } }

const RESOLVER_SELECTION_HINT =
  "By default, the generated transaction targets the name's current resolver. Use --resolver to override it."
const REVERSE_NAMESPACE = 'addr.reverse'
const rootRegistryAbi = parseAbi(['function ROOT_REGISTRY() view returns (address)'])

async function resolveTargetResolver(c: SetContext, name: string): Promise<`0x${string}`> {
  if (c.options.resolver) return getAddress(c.options.resolver)

  const { client } = clientFromContext(c)

  let resolver: `0x${string}` | null = null
  try {
    resolver = await getEnsResolver(client, { name, ...universalResolverParam(c) })
  } catch (error) {
    // The Universal Resolver reverts when no resolver is found; RPC failures still throw.
    if (!isUnsupportedCall(error)) throw error
  }

  // For names not in ENSv2, an ENSv2 Universal Resolver returns its read-only
  // ENSV1Resolver bridge. Writes must target the v1 resolver it mirrors.
  if (resolver && resolver !== zeroAddress) {
    try {
      const [underlying] = await client.readContract({
        address: resolver,
        abi: compositeResolverAbi,
        functionName: 'getResolver',
        args: [toHex(packetToBytes(name))],
      })
      // Zero means the v1 name has no resolver, so there is nothing writable.
      resolver = underlying
    } catch (error) {
      // Not a composite resolver — write to it directly. RPC failures must not
      // fall through, or the calldata could target the read-only bridge.
      if (!isUnsupportedCall(error)) throw error
    }
  }

  if (!resolver || resolver === zeroAddress) {
    throw new Error(
      `No resolver set for "${name}". Pass --resolver <address> to target a specific resolver, or set one on the registry first.`,
    )
  }

  return resolver
}

/** Resolves the target resolver and its record encoding, with a warning when writes may revert. */
async function recordTarget(c: SetContext, name: string) {
  const { client } = clientFromContext(c)
  const resolver = await resolveTargetResolver(c, name)
  const v2 = await supportsV2RecordSetters(client, resolver)
  const encode = (operation: RecordOperation) =>
    v2 ? encodeV2RecordOperation(name, operation) : encodeRecordOperation(namehash(name), operation)
  const warning = v2 ? undefined : await v1ResolverWarning(c, name, resolver)
  return { resolver, encode, ...(warning ? { warning } : {}) }
}

/**
 * The ENSv1 Public Resolver authorizes writes through ENSv1 registry ownership, which migration
 * gives up, so its records are read-only once the name is registered in ENSv2. Custom resolvers
 * may authorize writes some other way, so this can't be stated outright.
 */
async function v1ResolverWarning(c: SetContext, name: string, resolver: `0x${string}`) {
  if (eth2ldLabel(name) == null) return undefined
  const { client, chain } = clientFromContext(c)
  // PublicResolverV2 keeps the namehash setters but authorizes through the ENSv2 registry.
  try {
    await client.readContract({
      address: resolver,
      abi: rootRegistryAbi,
      functionName: 'ROOT_REGISTRY',
    })
    return undefined
  } catch (error) {
    if (!isUnsupportedCall(error)) throw error
  }
  const v2 = await isV2Active(c, name)
  if (!v2.isV2 || v2.nameState.status !== V2Status.REGISTERED) return undefined
  return `"${name}" is registered in ENSv2, but ${resolver} lacks ENSv2 record setters. If it authorizes updates through ENSv1 registry ownership, as the ENSv1 Public Resolver does, this transaction will revert. To replace it, deploy an OwnedResolver with "ens resolver deploy <owner> --name ${name} --records <json> --chain ${chain}", then point the name at it with "ens resolver set ${name} --resolver <address> --chain ${chain}".`
}

async function resolveReverseRegistrar(c: Context): Promise<`0x${string}`> {
  const { client, chain } = clientFromContext(c)
  const reverseRegistrar = await client.readContract({
    address: addresses[chain].registry,
    abi: ensRegistryAbi,
    functionName: 'owner',
    args: [namehash(REVERSE_NAMESPACE)],
  })

  if (reverseRegistrar === zeroAddress) {
    throw new Error(`No ETH reverse registrar owns "${REVERSE_NAMESPACE}"`)
  }
  return reverseRegistrar
}

function encodeSetReverse(name: string): `0x${string}` {
  return encodeFunctionData({
    abi: reverseRegistrarAbi,
    functionName: 'setName',
    args: [name],
  })
}

function normalizeReverseName(name: string): string {
  return name === '' ? '' : validateName(name)
}

const resolverOption = z.object({
  resolver: z
    .string()
    .optional()
    .describe("Resolver contract to target instead of the name's current resolver"),
})

export const setCommands = Cli.create('set', {
  description: 'Set ENS records (outputs calldata JSON)',
})
  .command('name', {
    description: 'Generate calldata to set an ETH reverse record',
    hint: 'The transaction sender is the address whose reverse record will be changed. A functional primary name requires bidirectional resolution: the name must forward-resolve to that same address.',
    args: z.object({
      name: z
        .string()
        .describe("ENS name to store in the sender's reverse record (e.g. myname.eth)"),
    }),
    options: globalOptions.omit({ universalResolver: true }),
    env: globalEnv,
    examples: [
      {
        args: { name: 'myname.eth' },
        description: "Set the sender's reverse record to myname.eth",
      },
      {
        args: { name: '' },
        description: "Clear the sender's reverse record",
      },
    ],
    async run(c) {
      const name = normalizeReverseName(c.args.name)
      const reverseRegistrar = await resolveReverseRegistrar(c)
      const data = encodeSetReverse(name)
      return { to: reverseRegistrar, data, value: '0', name, reverseRegistrar }
    },
  })
  .command('address', {
    description: 'Generate calldata to set an address record',
    hint: RESOLVER_SELECTION_HINT,
    args: z.object({
      name: z.string().describe('ENS name (e.g. myname.eth)'),
    }),
    options: globalOptions
      .merge(resolverOption)
      .merge(coinTypeOptions)
      .merge(
        z.object({
          address: z.string().describe('Address to set'),
        }),
      ),
    env: globalEnv,
    examples: [
      {
        args: { name: 'myname.eth' },
        options: { address: '0x0000000000000000000000000000000000000001' },
        description: 'Set the default Ethereum address',
      },
    ],
    async run(c) {
      const name = validateName(c.args.name)
      const coinType = resolveCoinType(c.options)
      const { resolver, encode, ...warning } = await recordTarget(c, name)
      const data = encode({ type: 'address', address: c.options.address, coinType })
      return { to: resolver, data, value: '0', ...warning }
    },
  })
  .command('text', {
    description: 'Generate calldata to set a text record',
    hint: RESOLVER_SELECTION_HINT,
    args: z.object({
      name: z.string().describe('ENS name (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(resolverOption).merge(
      z.object({
        key: z.string().describe('Text record key (e.g. com.twitter, url)'),
        value: z.string().describe('Text record value'),
      }),
    ),
    env: globalEnv,
    examples: [
      {
        args: { name: 'myname.eth' },
        options: { key: 'url', value: 'https://example.com' },
        description: 'Set a URL text record',
      },
    ],
    async run(c) {
      const name = validateName(c.args.name)
      const { resolver, encode, ...warning } = await recordTarget(c, name)
      const data = encode({ type: 'text', key: c.options.key, value: c.options.value })
      return { to: resolver, data, value: '0', ...warning }
    },
  })
  .command('contenthash', {
    description: 'Generate calldata to set a contenthash record',
    hint: RESOLVER_SELECTION_HINT,
    args: z.object({
      name: z.string().describe('ENS name (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(resolverOption).merge(
      z.object({
        hash: z.string().describe('Content hash in hex (EIP-1577 encoded)'),
      }),
    ),
    env: globalEnv,
    examples: [
      {
        args: { name: 'myname.eth' },
        options: {
          hash: '0xe30101701220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        description: 'Set an IPFS contenthash',
      },
    ],
    async run(c) {
      const name = validateName(c.args.name)
      const { resolver, encode, ...warning } = await recordTarget(c, name)
      const data = encode({ type: 'contenthash', hash: c.options.hash })
      return { to: resolver, data, value: '0', ...warning }
    },
  })
  .command('batch', {
    description: 'Generate multicall calldata to set multiple records',
    hint: `ETH uses coin type 60: {"type":"address","address":"0x...","coinType":60}. Use chainId for another EVM chain or coinType for another asset (0=BTC). ${RESOLVER_SELECTION_HINT}`,
    args: z.object({
      name: z.string().describe('ENS name (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(resolverOption).merge(
      z.object({
        data: z.string().describe('JSON array of address, text, or contenthash operations'),
      }),
    ),
    env: globalEnv,
    examples: [
      {
        args: { name: 'myname.eth' },
        options: {
          data: `'[{"type":"text","key":"url","value":"https://example.com"}]'`,
        },
        description: 'Set records in a single transaction',
      },
    ],
    async run(c) {
      const name = validateName(c.args.name)
      const operations = parseRecordOperations(c.options.data)
      const { resolver, encode, ...warning } = await recordTarget(c, name)
      const calls = operations.map(encode)

      const data = encodeFunctionData({
        abi: publicResolverAbi,
        functionName: 'multicall',
        args: [calls],
      })

      return { to: resolver, data, value: '0', ...warning }
    },
  })
