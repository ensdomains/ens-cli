import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { encodeFunctionData, getAddress } from 'viem/utils'
import { getEnsResolver, namehash } from 'viem/ens'
import { validateName, asHex } from '../lib/utils.ts'
import { publicResolverAbi } from '../lib/contracts.ts'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  universalResolverParam,
  type Context,
} from '../lib/context.ts'
import { coinTypeOptions, resolveCoinType } from '../lib/cointype.ts'

const batchOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('address'),
    address: z.string(),
    coinType: z.number().optional(),
    chainId: z.number().optional(),
  }),
  z.object({ type: z.literal('text'), key: z.string(), value: z.string() }),
  z.object({ type: z.literal('contenthash'), hash: z.string() }),
])

type BatchOperation = z.infer<typeof batchOperationSchema>

type SetContext = Context & { options: { resolver?: string } }

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
  if (coinType != null) {
    return encodeFunctionData({
      abi: publicResolverAbi,
      functionName: 'setAddr',
      args: [node, BigInt(coinType), asHex(address, 'address')],
    })
  }
  return encodeFunctionData({
    abi: publicResolverAbi,
    functionName: 'setAddr',
    args: [node, getAddress(address)],
  })
}

function encodeSetText(node: `0x${string}`, key: string, value: string): `0x${string}` {
  return encodeFunctionData({
    abi: publicResolverAbi,
    functionName: 'setText',
    args: [node, key, value],
  })
}

function encodeSetContenthash(node: `0x${string}`, hash: string): `0x${string}` {
  return encodeFunctionData({
    abi: publicResolverAbi,
    functionName: 'setContenthash',
    args: [node, asHex(hash, 'contenthash')],
  })
}

function encodeBatchOperation(node: `0x${string}`, op: BatchOperation): `0x${string}` {
  switch (op.type) {
    case 'address':
      return encodeSetAddr(node, op.address, resolveCoinType(op))
    case 'text':
      return encodeSetText(node, op.key, op.value)
    case 'contenthash':
      return encodeSetContenthash(node, op.hash)
  }
}

const resolverOption = z.object({
  resolver: z
    .string()
    .optional()
    .describe(
      'Resolver address to target. If omitted, the resolver is read from the Universal Resolver; if none is set, the command fails.',
    ),
})

export const setCommands = Cli.create('set', {
  description: 'Set ENS records (outputs calldata JSON)',
})
  .command('address', {
    description:
      'Generate calldata to set the address record for an ENS name. Resolves the target resolver via the Universal Resolver unless --resolver is passed.',
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
    description:
      'Generate calldata to set a text record for an ENS name. Resolves the target resolver via the Universal Resolver unless --resolver is passed.',
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
    async run(c) {
      const name = validateName(c.args.name)
      const resolverAddress = await resolveTargetResolver(c, name)
      const node = namehash(name)
      const data = encodeSetText(node, c.options.key, c.options.value)
      return { to: resolverAddress, data, value: '0' }
    },
  })
  .command('contenthash', {
    description:
      'Generate calldata to set the content hash for an ENS name. Resolves the target resolver via the Universal Resolver unless --resolver is passed.',
    args: z.object({
      name: z.string().describe('ENS name (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(resolverOption).merge(
      z.object({
        hash: z.string().describe('Content hash in hex (EIP-1577 encoded)'),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const name = validateName(c.args.name)
      const resolverAddress = await resolveTargetResolver(c, name)
      const node = namehash(name)
      const data = encodeSetContenthash(node, c.options.hash)
      return { to: resolverAddress, data, value: '0' }
    },
  })
  .command('batch', {
    description:
      'Generate multicall calldata to set multiple records in a single transaction. Pass a JSON array of operations. Resolves the target resolver via the Universal Resolver unless --resolver is passed.',
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
    async run(c) {
      const name = validateName(c.args.name)
      const resolverAddress = await resolveTargetResolver(c, name)
      const node = namehash(name)
      const operations = z.array(batchOperationSchema).parse(JSON.parse(c.options.data))
      const calls = operations.map((op) => encodeBatchOperation(node, op))

      const data = encodeFunctionData({
        abi: publicResolverAbi,
        functionName: 'multicall',
        args: [calls],
      })

      return { to: resolverAddress, data, value: '0' }
    },
  })
