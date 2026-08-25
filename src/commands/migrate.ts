import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { encodeAbiParameters, encodeFunctionData, getAddress, isAddressEqual } from 'viem/utils'
import { labelhash, namehash } from 'viem/ens'
import {
  addresses,
  baseRegistrarAbi,
  ensRegistryAbi,
  nameWrapperAbi,
  v2RegistryAbi,
} from '../lib/contracts.ts'
import { activeV2Deployment, clientFromContext, globalEnv, globalOptions } from '../lib/context.ts'
import { eth2ldLabel, validateName } from '../lib/utils.ts'
import { V2Status, resolveDeployedOwnedResolver } from '../lib/v2.ts'

// ENSv1 NameWrapper fuse bitmap values mirrored from INameWrapper.sol.
// Source: https://github.com/ensdomains/ens-contracts/blob/3b1cc225ccdf64581d5fdc81db574f51ba5c8c09/contracts/wrapper/INameWrapper.sol#L10-L16
const CANNOT_UNWRAP = 1 // bit 0
const CANNOT_TRANSFER = 4 // bit 2
const CANNOT_SET_RESOLVER = 8 // bit 3
const CANNOT_APPROVE = 64 // bit 6

export const migrateCommand = Cli.create('migrate', {
  description: 'Migrate a .eth name from ENSv1 to ENSv2.',
  hint: 'Generates unsigned calldata only. The name must be a pre-migrated RESERVED .eth 2LD. The command detects unwrapped, wrapped-unlocked, and wrapped-locked names and selects the matching controller. Review all returned flags before broadcasting. The transaction is one-way and must be sent by the current ENSv1 owner or an approved operator.',
  args: z.object({
    name: z.string().describe('ENSv1 .eth name to migrate (e.g. myname.eth)'),
  }),
  options: globalOptions.merge(
    z.object({
      owner: z
        .string()
        .optional()
        .describe('ENSv2 owner after migration (default: current ENSv1 token owner)'),
      resolver: z
        .string()
        .optional()
        .describe(
          'ENSv2 resolver after migration (default: deployed OwnedResolver for the v2 owner, otherwise current ENSv1 resolver)',
        ),
      subregistry: z
        .string()
        .optional()
        .describe(
          'ENSv2 subregistry for an unlocked name (default: zero address; ignored for locked names, whose WrapperRegistry is deployed automatically)',
        ),
      lockedController: z
        .string()
        .optional()
        .describe('Override the configured LockedMigrationController address'),
      unlockedController: z
        .string()
        .optional()
        .describe('Override the configured UnlockedMigrationController address'),
    }),
  ),
  examples: [
    {
      description: 'Migrate a reserved Sepolia name with its current owner and default resolver',
      args: { name: 'myname.eth' },
      options: { chain: 'sepolia' },
    },
    {
      description: 'Choose the ENSv2 owner, resolver, and unlocked-name subregistry',
      args: { name: 'myname.eth' },
      options: {
        chain: 'sepolia',
        owner: '0x0000000000000000000000000000000000000001',
        resolver: '0x0000000000000000000000000000000000000002',
        subregistry: '0x0000000000000000000000000000000000000003',
      },
    },
  ],
  env: globalEnv,
  async run(c) {
    const { client, chain } = clientFromContext(c)
    const name = validateName(c.args.name)
    const label = eth2ldLabel(name)
    if (label == null) {
      throw new Error(`ENSv1 to v2 migration currently only supports .eth 2LD names. Got: ${name}`)
    }

    const v2Deployment = await activeV2Deployment(c)
    if (!v2Deployment) {
      throw new Error(`ENSv2 migration is not active or configured for chain "${chain}"`)
    }

    const registry = addresses[chain].registry
    const baseRegistrar = addresses[chain].baseRegistrar
    const nameWrapper = addresses[chain].nameWrapper
    const node = namehash(name)
    const nodeId = BigInt(node)
    const labelId = BigInt(labelhash(label))

    const [{ status }, registryOwner, currentResolver, v1Expiry, latestBlock] = await Promise.all([
      client.readContract({
        address: v2Deployment.registry,
        abi: v2RegistryAbi,
        functionName: 'getState',
        args: [labelId],
      }),
      client.readContract({
        address: registry,
        abi: ensRegistryAbi,
        functionName: 'owner',
        args: [node],
      }),
      client.readContract({
        address: registry,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [node],
      }),
      client.readContract({
        address: baseRegistrar,
        abi: baseRegistrarAbi,
        functionName: 'nameExpires',
        args: [labelId],
      }),
      client.getBlock(),
    ])

    if (status === V2Status.REGISTERED) {
      throw new Error(`"${name}" is already registered in ENSv2`)
    }
    if (status !== V2Status.RESERVED) {
      throw new Error(
        `"${name}" is not reserved for ENSv1 migration in ENSv2 (status=${status}). Only pre-migrated RESERVED names can be migrated.`,
      )
    }
    if (v1Expiry <= latestBlock.timestamp) {
      throw new Error(
        `"${name}" is expired in ENSv1 and cannot be migrated during the v1 grace period. Renew it through ETHRenewerV1, then retry. (v1Expiry=${v1Expiry}, blockTimestamp=${latestBlock.timestamp})`,
      )
    }

    const wrapped = isAddressEqual(registryOwner, nameWrapper)
    let currentOwner: `0x${string}`
    let fuses = 0

    if (wrapped) {
      const wrapperData = await client.readContract({
        address: nameWrapper,
        abi: nameWrapperAbi,
        functionName: 'getData',
        args: [nodeId],
      })
      currentOwner = wrapperData[0]
      fuses = wrapperData[1]
    } else {
      currentOwner = await client.readContract({
        address: baseRegistrar,
        abi: baseRegistrarAbi,
        functionName: 'ownerOf',
        args: [labelId],
      })
    }

    if (isAddressEqual(currentOwner, zeroAddress)) {
      throw new Error(`"${name}" has no current ENSv1 token owner and cannot be migrated`)
    }

    const kind = !wrapped
      ? 'unwrapped'
      : (fuses & CANNOT_UNWRAP) !== 0
        ? 'wrapped-locked'
        : 'wrapped-unlocked'
    if (kind === 'wrapped-locked' && (fuses & CANNOT_TRANSFER) !== 0) {
      throw new Error(
        `"${name}" has the CANNOT_TRANSFER fuse burned. ENSv1 NameWrapper blocks the transfer required for migration.`,
      )
    }

    const tokenApproval =
      kind === 'wrapped-locked' && (fuses & CANNOT_APPROVE) !== 0
        ? await client.readContract({
            address: nameWrapper,
            abi: nameWrapperAbi,
            functionName: 'getApproved',
            args: [nodeId],
          })
        : zeroAddress

    const owner = c.options.owner ? getAddress(c.options.owner) : currentOwner
    const resolverPayloadIgnored = kind === 'wrapped-locked' && (fuses & CANNOT_SET_RESOLVER) !== 0
    const ownedResolver =
      c.options.resolver == null && !resolverPayloadIgnored
        ? await resolveDeployedOwnedResolver({
            client,
            factory: v2Deployment.resolverFactory,
            proxyLogic: v2Deployment.resolverProxyLogic,
            owner,
          })
        : zeroAddress
    const resolver = c.options.resolver
      ? getAddress(c.options.resolver)
      : !isAddressEqual(ownedResolver, zeroAddress)
        ? ownedResolver
        : currentResolver
    const subregistry = c.options.subregistry ? getAddress(c.options.subregistry) : zeroAddress
    const lockedController = c.options.lockedController
      ? getAddress(c.options.lockedController)
      : v2Deployment.lockedMigrationController
    const unlockedController = c.options.unlockedController
      ? getAddress(c.options.unlockedController)
      : v2Deployment.unlockedMigrationController
    for (const [field, address] of [
      ['owner', owner],
      ['locked controller', lockedController],
      ['unlocked controller', unlockedController],
    ] as const) {
      if (isAddressEqual(address, zeroAddress))
        throw new Error(`${field} cannot be the zero address`)
    }

    const flags: string[] = []
    if (
      c.options.resolver == null &&
      !resolverPayloadIgnored &&
      isAddressEqual(ownedResolver, zeroAddress)
    ) {
      flags.push(
        `Recommendation: no canonical OwnedResolver is deployed for ${owner}, so the current ENSv1 resolver is being reused. Verify it authorizes the ENSv2 owner to update records, or run "ens resolver deploy ${owner} --chain ${chain}" and regenerate this migration with --resolver <address>.`,
      )
    }
    if (wrapped) {
      flags.push(
        `Assumption: registry ownership by ${nameWrapper} identifies the name as wrapped; the CANNOT_UNWRAP fuse selects the ${kind} path.`,
        'Assumption: the sender will be the current token owner or an approved operator; authorization is not checked.',
      )
      if (resolverPayloadIgnored) {
        flags.push(
          'Warning: CANNOT_SET_RESOLVER causes the resolver payload to be ignored; the v1 resolver is preserved and a known PublicResolver may be replaced with PublicResolverV2.',
        )
      }
      if (
        kind === 'wrapped-locked' &&
        (fuses & CANNOT_APPROVE) !== 0 &&
        !isAddressEqual(tokenApproval, zeroAddress)
      ) {
        flags.push(
          `Warning: CANNOT_APPROVE is burned while getApproved() is ${tokenApproval}; migration is expected to revert with FrozenTokenApproval.`,
        )
      }
      if (kind === 'wrapped-locked' && c.options.subregistry != null) {
        flags.push(
          'Warning: the locked controller ignores --subregistry and deploys a WrapperRegistry from the v1 fuse state.',
        )
      }
      if (
        (kind === 'wrapped-locked' && c.options.lockedController != null) ||
        (kind === 'wrapped-unlocked' && c.options.unlockedController != null)
      ) {
        flags.push(
          'Warning: the controller override is assumed compatible with the configured NameWrapper and ENSv2 registry; its bytecode and configuration are not verified.',
        )
      }
    }

    const payload = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'label', type: 'string' },
            { name: 'owner', type: 'address' },
            { name: 'subregistry', type: 'address' },
            { name: 'resolver', type: 'address' },
          ],
        },
      ],
      [{ label, owner, subregistry, resolver }],
    )
    const controller = kind === 'wrapped-locked' ? lockedController : unlockedController
    const transaction =
      kind === 'unwrapped'
        ? {
            to: baseRegistrar,
            data: encodeFunctionData({
              abi: baseRegistrarAbi,
              functionName: 'safeTransferFrom',
              args: [currentOwner, controller, labelId, payload],
            }),
          }
        : {
            to: nameWrapper,
            data: encodeFunctionData({
              abi: nameWrapperAbi,
              functionName: 'safeTransferFrom',
              args: [currentOwner, controller, nodeId, 1n, payload],
            }),
          }

    return {
      to: transaction.to,
      data: transaction.data,
      value: '0',
      name,
      kind,
      currentOwner,
      owner,
      resolver,
      ...(kind === 'wrapped-locked' ? {} : { subregistry }),
      flags,
      controller,
    }
  },
})
