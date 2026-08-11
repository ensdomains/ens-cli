import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { encodeFunctionData, getAddress } from 'viem/utils'
import { getEnsResolver, namehash } from 'viem/ens'
import { validateName } from '../lib/utils.ts'
import {
  addresses,
  ensRegistryAbi,
  publicResolverAbi,
  reverseRegistrarAbi,
} from '../lib/contracts.ts'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  universalResolverParam,
  type Context,
} from '../lib/context.ts'
import { coinTypeOptions, resolveCoinType } from '../lib/cointype.ts'
import { encodeRecordOperation, parseRecordOperations } from '../lib/records.ts'

type SetContext = Context & { options: { resolver?: string } }

const RESOLVER_SELECTION_HINT =
  "By default, the generated transaction targets the name's current resolver. Use --resolver to override it."
const REVERSE_NAMESPACE = 'addr.reverse'

async function resolveTargetResolver(c: SetContext, name: string): Promise<`0x${string}`> {
  if (c.options.resolver) return getAddress(c.options.resolver)

  const { client } = clientFromContext(c)

  let resolver: `0x${string}` | null = null
  try {
    resolver = await getEnsResolver(client, { name, ...universalResolverParam(c) })
  } catch {
    // Universal Resolver lookup failed — fall through to the no-resolver error
  }

  if (!resolver || resolver === zeroAddress) {
    throw new Error(
      `No resolver set for "${name}". Pass --resolver <address> to target a specific resolver, or set one on the registry first.`,
    )
  }

  return resolver
}

function encodeSetAddr(node: `0x${string}`, address: string, coinType?: number): `0x${string}` {
  return encodeRecordOperation(node, { type: 'address', address, coinType })
}

function encodeSetText(node: `0x${string}`, key: string, value: string): `0x${string}` {
  return encodeRecordOperation(node, { type: 'text', key, value })
}

function encodeSetContenthash(node: `0x${string}`, hash: string): `0x${string}` {
  return encodeRecordOperation(node, { type: 'contenthash', hash })
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
      const resolverAddress = await resolveTargetResolver(c, name)
      const node = namehash(name)
      const coinType = resolveCoinType(c.options)
      const data = encodeSetAddr(node, c.options.address, coinType)
      return { to: resolverAddress, data, value: '0' }
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
      const resolverAddress = await resolveTargetResolver(c, name)
      const node = namehash(name)
      const data = encodeSetText(node, c.options.key, c.options.value)
      return { to: resolverAddress, data, value: '0' }
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
      const resolverAddress = await resolveTargetResolver(c, name)
      const node = namehash(name)
      const data = encodeSetContenthash(node, c.options.hash)
      return { to: resolverAddress, data, value: '0' }
    },
  })
  .command('batch', {
    description: 'Generate multicall calldata to set multiple records',
    hint: `Pass a JSON array of record operations. ${RESOLVER_SELECTION_HINT}`,
    args: z.object({
      name: z.string().describe('ENS name (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(resolverOption).merge(
      z.object({
        data: z
          .string()
          .describe(
            'JSON array of operations: [{"type":"text","key":"url","value":"https://..."},{"type":"address","address":"0x...","chainId":10},{"type":"address","address":"0x...","coinType":0},{"type":"contenthash","hash":"0x..."}]',
          ),
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
      const resolverAddress = await resolveTargetResolver(c, name)
      const node = namehash(name)
      const operations = parseRecordOperations(c.options.data)
      const calls = operations.map((operation) => encodeRecordOperation(node, operation))

      const data = encodeFunctionData({
        abi: publicResolverAbi,
        functionName: 'multicall',
        args: [calls],
      })

      return { to: resolverAddress, data, value: '0' }
    },
  })
