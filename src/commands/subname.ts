import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { encodeFunctionData, getAddress, isAddressEqual } from 'viem/utils'
import { labelhash, namehash } from 'viem/ens'
import { addresses, ensRegistryAbi, nameWrapperAbi, v2RegistryAbi } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext, activeV2Deployment } from '../lib/context.ts'
import { durationFromOption, validateName } from '../lib/utils.ts'
import {
  V2_DEFAULT_OWNER_ROLE_BITMAP,
  getV2ParentRegistryForName,
  parseBigIntOption,
  resolveDeployedOwnedResolver,
} from '../lib/v2.ts'

const TTL = 0n

export const subnameCommands = Cli.create('subname', {
  description: 'Create and manage ENS subnames',
}).command('create', {
  description:
    'Generate calldata to create a subname. On ENSv2, targets the parent subregistry. On ENSv1, reads the parent owner and targets either the NameWrapper or registry.',
  args: z.object({
    name: z.string().describe('Full subname to create (e.g. sub.parent.eth)'),
  }),
  options: globalOptions.merge(
    z.object({
      owner: z.string().describe('Address that will own the new subname'),
      resolver: z
        .string()
        .optional()
        .describe(
          'Resolver address for the subname (defaults to deployed owner owned resolver on ENSv2, chain public resolver on ENSv1)',
        ),
      subregistry: z
        .string()
        .optional()
        .describe('ENSv2 child subregistry address for the new subname (default: zero address)'),
      duration: z.coerce
        .number()
        .optional()
        .describe(
          'ENSv2 registration duration in seconds when --expiry is omitted (default: 1 year)',
        ),
      roleBitmap: z
        .string()
        .optional()
        .describe(
          'ENSv2 roles granted to the new owner as decimal or 0x hex (default: unregister/renew/set subregistry/set resolver plus admin roles)',
        ),
      fuses: z.coerce
        .number()
        .optional()
        .describe(
          'NameWrapper fuses bitmask for the new subname (default: 0). Ignored when the parent is unwrapped.',
        ),
      expiry: z.coerce
        .number()
        .optional()
        .describe(
          'NameWrapper expiry as a unix timestamp for the new subname (default: 0). Ignored when the parent is unwrapped.',
        ),
    }),
  ),
  env: globalEnv,
  async run(c) {
    const { client, chain } = clientFromContext(c)
    const name = validateName(c.args.name)
    const v2Deployment = await activeV2Deployment(c)

    if (v2Deployment) {
      const parent = await getV2ParentRegistryForName({
        client,
        rootRegistry: v2Deployment.registry,
        name,
      })

      if (parent.parent === 'eth') {
        throw new Error(`Use ens register to create 2LD .eth names. Got: ${name}`)
      }

      if (isAddressEqual(parent.registry, zeroAddress)) {
        throw new Error(
          `Parent "${parent.parent}" has no ENSv2 subregistry, so "${name}" cannot be created. Run subregistry deploy/set for "${parent.missingName}" first.`,
        )
      }

      const owner = getAddress(c.options.owner)
      const resolver = c.options.resolver
        ? getAddress(c.options.resolver)
        : await resolveDeployedOwnedResolver({
            client,
            factory: v2Deployment.resolverFactory,
            proxyLogic: v2Deployment.resolverProxyLogic,
            owner,
          })
      const childSubregistry = c.options.subregistry
        ? getAddress(c.options.subregistry)
        : zeroAddress
      const roleBitmap = parseBigIntOption(c.options.roleBitmap, V2_DEFAULT_OWNER_ROLE_BITMAP)
      const expiry =
        c.options.expiry == null
          ? BigInt((await client.getBlock()).timestamp) + durationFromOption(c.options.duration)
          : BigInt(c.options.expiry)

      const data = encodeFunctionData({
        abi: v2RegistryAbi,
        functionName: 'register',
        args: [parent.label, owner, childSubregistry, resolver, roleBitmap, expiry],
      })

      return {
        to: parent.registry,
        data,
        value: '0',
        name,
        parent: parent.parent,
        label: parent.label,
        parentRegistry: parent.registry,
        owner,
        resolver,
        resolverSource:
          c.options.resolver != null
            ? 'option'
            : resolver === zeroAddress
              ? 'none'
              : 'ownedResolver',
        subregistry: childSubregistry,
        roleBitmap: roleBitmap.toString(),
        expiry: expiry.toString(),
        version: 'v2',
        note: 'Transaction must be sent by an account with the registrar role on the parent subregistry.',
      }
    }

    const registryAddress = addresses[chain].registry
    const nameWrapperAddress = addresses[chain].nameWrapper
    const dot = name.indexOf('.')
    const label = name.slice(0, dot)
    const parent = name.slice(dot + 1)
    const parentNode = namehash(parent)

    const parentRegistryOwner = await client.readContract({
      address: registryAddress,
      abi: ensRegistryAbi,
      functionName: 'owner',
      args: [parentNode],
    })

    if (parentRegistryOwner === zeroAddress) {
      throw new Error(
        `Parent "${parent}" has no owner in the ENS registry, so a subname cannot be created via onchain contracts.`,
      )
    }

    const owner = getAddress(c.options.owner)
    const resolver = c.options.resolver ? getAddress(c.options.resolver) : addresses[chain].resolver
    const labelHash = labelhash(label)
    const node = namehash(name)
    const isWrapped = isAddressEqual(parentRegistryOwner, nameWrapperAddress)

    if (isWrapped) {
      const wrappedOwner = await client.readContract({
        address: nameWrapperAddress,
        abi: nameWrapperAbi,
        functionName: 'ownerOf',
        args: [BigInt(parentNode)],
      })

      if (wrappedOwner === zeroAddress) {
        throw new Error(
          `Parent "${parent}" is owned by the NameWrapper but has no wrapped owner (likely expired). A subname cannot be created.`,
        )
      }

      const fuses = c.options.fuses ?? 0
      const expiry = BigInt(c.options.expiry ?? 0)

      const data = encodeFunctionData({
        abi: nameWrapperAbi,
        functionName: 'setSubnodeRecord',
        args: [parentNode, label, owner, resolver, TTL, fuses, expiry],
      })

      return {
        to: nameWrapperAddress,
        data,
        value: '0',
        name,
        parent,
        label,
        parentNode,
        labelHash,
        node,
        parentOwner: wrappedOwner,
        parentRegistryOwner,
        wrapped: true,
        owner,
        resolver,
        fuses,
        expiry: expiry.toString(),
        note: 'Parent is wrapped — call NameWrapper.setSubnodeRecord. Transaction must be sent from the wrapped owner (or an approved operator).',
      }
    }

    const data = encodeFunctionData({
      abi: ensRegistryAbi,
      functionName: 'setSubnodeRecord',
      args: [parentNode, labelHash, owner, resolver, TTL],
    })

    return {
      to: registryAddress,
      data,
      value: '0',
      name,
      parent,
      label,
      parentNode,
      labelHash,
      node,
      parentOwner: parentRegistryOwner,
      wrapped: false,
      owner,
      resolver,
      note: 'Transaction must be sent from the parent owner. If the parent owner above is a contract (e.g. a multisig), call it through that contract.',
    }
  },
})
