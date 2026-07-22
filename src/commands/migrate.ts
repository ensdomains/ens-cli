import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
} from 'viem/utils'
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

// ENSv1 NameWrapper fuse bitmap values mirrored from INameWrapper.sol.
// Source: https://github.com/ensdomains/ens-contracts/blob/3b1cc225ccdf64581d5fdc81db574f51ba5c8c09/contracts/wrapper/INameWrapper.sol#L10-L16
export const CANNOT_UNWRAP = 1 // bit 0
export const CANNOT_TRANSFER = 4 // bit 2
export const CANNOT_SET_RESOLVER = 8 // bit 3
export const CANNOT_APPROVE = 64 // bit 6

// Solidity assigns zero-based ordinals to IPermissionedRegistry.Status:
// AVAILABLE = 0, RESERVED = 1, REGISTERED = 2.
// Source: https://github.com/ensdomains/contracts-v2/blob/48b3e2d39513b9dd32ef1850877a29009bc807b9/contracts/src/registry/interfaces/IPermissionedRegistry.sol#L16-L20
export const V2_STATUS_RESERVED = 1
export const V2_STATUS_REGISTERED = 2

export const migrationDataComponents = [
  { name: 'label', type: 'string' },
  { name: 'owner', type: 'address' },
  { name: 'subregistry', type: 'address' },
  { name: 'resolver', type: 'address' },
] as const

export type MigrationKind = 'unwrapped' | 'wrapped-unlocked' | 'wrapped-locked'

export type MigrationData = {
  label: string
  owner: `0x${string}`
  subregistry: `0x${string}`
  resolver: `0x${string}`
}

export type MigrationFlag = {
  type: 'assumption' | 'warning'
  code: string
  message: string
}

export function classifyMigration(wrapped: boolean, fuses: number): MigrationKind {
  if (!wrapped) return 'unwrapped'
  return (fuses & CANNOT_UNWRAP) !== 0 ? 'wrapped-locked' : 'wrapped-unlocked'
}

export function requiredMigrationAddress(value: string, field: string): `0x${string}` {
  const address = getAddress(value)
  if (isAddressEqual(address, zeroAddress)) {
    throw new Error(`${field} cannot be the zero address`)
  }
  return address
}

export function assertMigrationNotExpired(name: string, v1Expiry: bigint, blockTimestamp: bigint) {
  if (v1Expiry <= blockTimestamp) {
    throw new Error(
      `"${name}" is expired in ENSv1 and cannot be migrated during the v1 grace period. Renew it through ETHRenewerV1, then retry. (v1Expiry=${v1Expiry}, blockTimestamp=${blockTimestamp})`,
    )
  }
}

export function wrappedMigrationFlags(opts: {
  wrapped: boolean
  kind: MigrationKind
  fuses: number
  tokenApproval: `0x${string}` | null
  resolverOverrideProvided: boolean
  subregistryOverrideProvided: boolean
  controllerOverrideProvided: boolean
  nameWrapper: `0x${string}`
}): MigrationFlag[] {
  if (!opts.wrapped) return []

  const locked = opts.kind === 'wrapped-locked'
  const flags: MigrationFlag[] = [
    {
      type: 'assumption',
      code: 'WRAPPED_STATUS_INFERRED',
      message: `The name is treated as wrapped because its ENSv1 registry owner matches the configured NameWrapper (${opts.nameWrapper}).`,
    },
    {
      type: 'assumption',
      code: 'MIGRATION_PATH_INFERRED',
      message: locked
        ? 'The locked migration path is selected because CANNOT_UNWRAP is burned.'
        : 'The unlocked migration path is selected because CANNOT_UNWRAP is not burned.',
    },
    {
      type: 'assumption',
      code: 'SENDER_AUTHORIZATION_NOT_VERIFIED',
      message:
        'The transaction sender is assumed to be the current NameWrapper token owner or an approved operator; sender authorization was not verified.',
    },
  ]

  if (locked && (opts.fuses & CANNOT_SET_RESOLVER) !== 0) {
    flags.push({
      type: 'warning',
      code: 'RESOLVER_PAYLOAD_IGNORED',
      message: opts.resolverOverrideProvided
        ? 'The LockedMigrationController will ignore --resolver because CANNOT_SET_RESOLVER is burned. It preserves the ENSv1 resolver and may replace a known PublicResolver with PublicResolverV2.'
        : 'The LockedMigrationController will ignore the resolver in the payload because CANNOT_SET_RESOLVER is burned. It preserves the ENSv1 resolver and may replace a known PublicResolver with PublicResolverV2.',
    })
  }

  if (
    locked &&
    (opts.fuses & CANNOT_APPROVE) !== 0 &&
    opts.tokenApproval != null &&
    !isAddressEqual(opts.tokenApproval, zeroAddress)
  ) {
    flags.push({
      type: 'warning',
      code: 'FROZEN_TOKEN_APPROVAL',
      message: `CANNOT_APPROVE is burned while getApproved() is ${opts.tokenApproval}. The LockedMigrationController is expected to revert with FrozenTokenApproval.`,
    })
  }

  if (locked && opts.subregistryOverrideProvided) {
    flags.push({
      type: 'warning',
      code: 'SUBREGISTRY_PAYLOAD_IGNORED',
      message:
        'The LockedMigrationController will ignore --subregistry and deploy a WrapperRegistry derived from the v1 fuse state.',
    })
  }

  if (opts.controllerOverrideProvided) {
    flags.push({
      type: 'warning',
      code: 'CONTROLLER_OVERRIDE_UNVERIFIED',
      message:
        'The controller override is assumed to be compatible with the configured NameWrapper and ENSv2 registry; its bytecode and immutable configuration were not verified.',
    })
  }

  return flags
}

export function encodeMigrationPayload(migration: MigrationData) {
  return encodeAbiParameters([{ type: 'tuple', components: migrationDataComponents }], [migration])
}

export function decodeMigrationPayload(payload: `0x${string}`) {
  return decodeAbiParameters([{ type: 'tuple', components: migrationDataComponents }], payload)[0]
}

export function buildMigrationTransaction(opts: {
  kind: MigrationKind
  currentOwner: `0x${string}`
  labelId: bigint
  nodeId: bigint
  nameWrapper: `0x${string}`
  baseRegistrar: `0x${string}`
  lockedController: `0x${string}`
  unlockedController: `0x${string}`
  migration: MigrationData
}) {
  const payload = encodeMigrationPayload(opts.migration)

  if (opts.kind === 'unwrapped') {
    return {
      to: opts.baseRegistrar,
      data: encodeFunctionData({
        abi: baseRegistrarAbi,
        functionName: 'safeTransferFrom',
        args: [opts.currentOwner, opts.unlockedController, opts.labelId, payload],
      }),
      controller: opts.unlockedController,
      tokenStandard: 'ERC721' as const,
      tokenId: opts.labelId,
      payload,
    }
  }

  const controller =
    opts.kind === 'wrapped-locked' ? opts.lockedController : opts.unlockedController

  return {
    to: opts.nameWrapper,
    data: encodeFunctionData({
      abi: nameWrapperAbi,
      functionName: 'safeTransferFrom',
      args: [opts.currentOwner, controller, opts.nodeId, 1n, payload],
    }),
    controller,
    tokenStandard: 'ERC1155' as const,
    tokenId: opts.nodeId,
    payload,
  }
}

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
        .describe('ENSv2 resolver after migration (default: current ENSv1 resolver)'),
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
      description: 'Migrate a reserved Sepolia name with its current owner and resolver',
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
  mcp: {
    instructions:
      'This tool reads onchain state and returns unsigned calldata; it does not broadcast a transaction. Treat the returned migration transaction as one-way. Review every returned flag, then confirm the name, current ENSv1 owner, destination owner, resolver, and selected controller before sending it.',
  },
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

    const [{ status, expiry, latestOwner }, registryOwner, currentResolver, v1Expiry, latestBlock] =
      await Promise.all([
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

    if (status === V2_STATUS_REGISTERED) {
      throw new Error(`"${name}" is already registered in ENSv2`)
    }
    if (status !== V2_STATUS_RESERVED) {
      throw new Error(
        `"${name}" is not reserved for ENSv1 migration in ENSv2 (status=${status}). Only pre-migrated RESERVED names can be migrated.`,
      )
    }
    assertMigrationNotExpired(name, v1Expiry, latestBlock.timestamp)

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

    const kind = classifyMigration(wrapped, fuses)
    if (kind === 'wrapped-locked' && (fuses & CANNOT_TRANSFER) !== 0) {
      throw new Error(
        `"${name}" has the CANNOT_TRANSFER fuse burned. ENSv1 NameWrapper blocks the transfer required for migration.`,
      )
    }

    const tokenApproval =
      kind === 'wrapped-locked'
        ? await client.readContract({
            address: nameWrapper,
            abi: nameWrapperAbi,
            functionName: 'getApproved',
            args: [nodeId],
          })
        : null

    const owner = c.options.owner
      ? requiredMigrationAddress(c.options.owner, 'owner')
      : currentOwner
    const resolver = c.options.resolver ? getAddress(c.options.resolver) : currentResolver
    const subregistry = c.options.subregistry ? getAddress(c.options.subregistry) : zeroAddress
    const lockedController = c.options.lockedController
      ? requiredMigrationAddress(c.options.lockedController, 'locked controller')
      : v2Deployment.lockedMigrationController
    const unlockedController = c.options.unlockedController
      ? requiredMigrationAddress(c.options.unlockedController, 'unlocked controller')
      : v2Deployment.unlockedMigrationController
    const flags = wrappedMigrationFlags({
      wrapped,
      kind,
      fuses,
      tokenApproval,
      resolverOverrideProvided: c.options.resolver != null,
      subregistryOverrideProvided: c.options.subregistry != null,
      controllerOverrideProvided:
        kind === 'wrapped-locked'
          ? c.options.lockedController != null
          : c.options.unlockedController != null,
      nameWrapper,
    })
    const migration = { label, owner, subregistry, resolver }
    const transaction = buildMigrationTransaction({
      kind,
      currentOwner,
      labelId,
      nodeId,
      nameWrapper,
      baseRegistrar,
      lockedController,
      unlockedController,
      migration,
    })

    return {
      to: transaction.to,
      data: transaction.data,
      value: '0',
      name,
      label,
      kind,
      wrapped,
      locked: kind === 'wrapped-locked',
      tokenStandard: transaction.tokenStandard,
      tokenId: transaction.tokenId.toString(),
      currentOwner,
      owner,
      resolver,
      subregistry,
      subregistryIgnored: kind === 'wrapped-locked',
      flags,
      fuses,
      v1Expiry: v1Expiry.toString(),
      v2ReservedExpiry: expiry.toString(),
      v2LatestOwner: latestOwner,
      controller: transaction.controller,
      registry: v2Deployment.registry,
      version: 'v1-to-v2',
      note: 'Review all returned flags before broadcasting. Migration is one-way and must be sent by the current ENSv1 owner or an approved operator. It transfers the v1 NFT to the migration controller and claims the pre-migrated ENSv2 reservation.',
    }
  },
})
