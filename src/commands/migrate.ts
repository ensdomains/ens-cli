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

export const CANNOT_UNWRAP = 1
export const CANNOT_TRANSFER = 4
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

export function classifyMigration(wrapped: boolean, fuses: number): MigrationKind {
  if (!wrapped) return 'unwrapped'
  return (fuses & CANNOT_UNWRAP) !== 0 ? 'wrapped-locked' : 'wrapped-unlocked'
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
  hint: 'Generates unsigned calldata only. The name must be a pre-migrated RESERVED .eth 2LD. The command detects unwrapped, wrapped-unlocked, and wrapped-locked names and selects the matching controller. Broadcasting the resulting transaction is one-way and must be done by the current ENSv1 owner or an approved operator.',
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
      'This tool reads onchain state and returns unsigned calldata; it does not broadcast a transaction. Treat the returned migration transaction as one-way. Confirm the name, current ENSv1 owner, destination owner, resolver, and selected controller before sending it.',
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

    const [{ status, expiry, latestOwner }, registryOwner, currentResolver] = await Promise.all([
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
    ])

    if (status === V2_STATUS_REGISTERED) {
      throw new Error(`"${name}" is already registered in ENSv2`)
    }
    if (status !== V2_STATUS_RESERVED) {
      throw new Error(
        `"${name}" is not reserved for ENSv1 migration in ENSv2 (status=${status}). Only pre-migrated RESERVED names can be migrated.`,
      )
    }

    const wrapped = isAddressEqual(registryOwner, nameWrapper)
    let currentOwner: `0x${string}`
    let fuses = 0
    let wrapperExpiry: bigint | undefined

    if (wrapped) {
      const wrapperData = await client.readContract({
        address: nameWrapper,
        abi: nameWrapperAbi,
        functionName: 'getData',
        args: [nodeId],
      })
      currentOwner = wrapperData[0]
      fuses = wrapperData[1]
      wrapperExpiry = wrapperData[2]
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

    const owner = c.options.owner ? getAddress(c.options.owner) : currentOwner
    const resolver = c.options.resolver ? getAddress(c.options.resolver) : currentResolver
    const subregistry = c.options.subregistry ? getAddress(c.options.subregistry) : zeroAddress
    const lockedController = c.options.lockedController
      ? getAddress(c.options.lockedController)
      : v2Deployment.lockedMigrationController
    const unlockedController = c.options.unlockedController
      ? getAddress(c.options.unlockedController)
      : v2Deployment.unlockedMigrationController
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
      fuses,
      v1Expiry: wrapperExpiry?.toString() ?? null,
      v2ReservedExpiry: expiry.toString(),
      v2LatestOwner: latestOwner,
      controller: transaction.controller,
      registry: v2Deployment.registry,
      version: 'v1-to-v2',
      note: 'Migration is one-way. Broadcast this transaction from the current ENSv1 owner or an approved operator. It transfers the v1 NFT to the migration controller and claims the pre-migrated ENSv2 reservation.',
    }
  },
})
