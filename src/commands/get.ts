import { Cli, z } from 'incur'
import { getAddress } from 'viem/utils'
import { getEnsAddress, getEnsName, getEnsText, getEnsAvatar } from 'viem/ens'
import { validateName } from '../lib/utils.ts'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  universalResolverParam,
} from '../lib/context.ts'
import { coinTypeOptions, resolveCoinType } from '../lib/cointype.ts'

const resolveOptions = coinTypeOptions.merge(globalOptions)

export const getCommands = Cli.create('get', {
  description: 'Read ENS data (addresses, names, text records, avatars)',
})
  .command('address', {
    description: 'Resolve an ENS name to an address',
    args: z.object({
      name: z.string().describe('ENS name to resolve (e.g. vitalik.eth)'),
    }),
    options: resolveOptions,
    env: globalEnv,
    async run(c) {
      const { client } = clientFromContext(c)
      const name = validateName(c.args.name)
      const coinType = resolveCoinType(c.options)
      const address = await getEnsAddress(client, {
        name,
        ...(coinType != null ? { coinType: BigInt(coinType) } : {}),
        ...universalResolverParam(c),
      })

      return {
        name,
        address,
        ...(coinType != null ? { coinType } : {}),
      }
    },
  })
  .command('name', {
    description: 'Reverse resolve an address to an ENS name',
    args: z.object({
      address: z.string().describe('Ethereum address to reverse resolve'),
    }),
    options: resolveOptions,
    env: globalEnv,
    async run(c) {
      const { client } = clientFromContext(c)
      const address = getAddress(c.args.address)
      const coinType = resolveCoinType(c.options)
      const name = await getEnsName(client, {
        address,
        ...(coinType != null ? { coinType: BigInt(coinType) } : {}),
        ...universalResolverParam(c),
      })
      return {
        address,
        name,
        ...(coinType != null ? { coinType } : {}),
      }
    },
  })
  .command('text', {
    description: 'Get a text record for an ENS name',
    args: z.object({
      name: z.string().describe('ENS name (e.g. vitalik.eth)'),
    }),
    options: globalOptions.merge(
      z.object({
        key: z.string().describe('Text record key (e.g. com.twitter, url, description)'),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client } = clientFromContext(c)
      const name = validateName(c.args.name)
      const value = await getEnsText(client, {
        name,
        key: c.options.key,
        ...universalResolverParam(c),
      })
      return { name, key: c.options.key, value }
    },
  })
  .command('avatar', {
    description: 'Get the avatar URL for an ENS name',
    args: z.object({
      name: z.string().describe('ENS name (e.g. vitalik.eth)'),
    }),
    options: globalOptions,
    env: globalEnv,
    async run(c) {
      const { client } = clientFromContext(c)
      const name = validateName(c.args.name)
      const avatar = await getEnsAvatar(client, {
        name,
        ...universalResolverParam(c),
      })
      return { name, avatar }
    },
  })
