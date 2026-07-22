import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, zeroAddress } from 'viem'
import { baseRegistrarAbi, nameWrapperAbi } from '../lib/contracts.ts'
import {
  CANNOT_APPROVE,
  CANNOT_SET_RESOLVER,
  CANNOT_UNWRAP,
  assertMigrationNotExpired,
  buildMigrationTransaction,
  classifyMigration,
  decodeMigrationPayload,
  requiredMigrationAddress,
  wrappedMigrationFlags,
  type MigrationData,
} from './migrate.ts'

const currentOwner = '0x0000000000000000000000000000000000000001'
const newOwner = '0x0000000000000000000000000000000000000002'
const resolver = '0x0000000000000000000000000000000000000003'
const baseRegistrar = '0x0000000000000000000000000000000000000010'
const nameWrapper = '0x0000000000000000000000000000000000000011'
const unlockedController = '0x0000000000000000000000000000000000000012'
const lockedController = '0x0000000000000000000000000000000000000013'
const labelId = 123n
const nodeId = 456n
const migration: MigrationData = {
  label: 'example',
  owner: newOwner,
  subregistry: zeroAddress,
  resolver,
}

describe('classifyMigration', () => {
  test('distinguishes unwrapped, unlocked wrapped, and locked wrapped names', () => {
    expect(classifyMigration(false, 0)).toBe('unwrapped')
    expect(classifyMigration(true, 0)).toBe('wrapped-unlocked')
    expect(classifyMigration(true, CANNOT_UNWRAP)).toBe('wrapped-locked')
  })
})

describe('requiredMigrationAddress', () => {
  test('accepts nonzero addresses and rejects the zero address', () => {
    expect(requiredMigrationAddress(currentOwner, 'owner')).toBe(currentOwner)
    expect(() => requiredMigrationAddress(zeroAddress, 'owner')).toThrow(
      'owner cannot be the zero address',
    )
  })
})

describe('assertMigrationNotExpired', () => {
  test('accepts active names and rejects names at or after expiry', () => {
    expect(() => assertMigrationNotExpired('example.eth', 101n, 100n)).not.toThrow()
    expect(() => assertMigrationNotExpired('example.eth', 100n, 100n)).toThrow(
      'cannot be migrated during the v1 grace period',
    )
    expect(() => assertMigrationNotExpired('example.eth', 99n, 100n)).toThrow(
      'Renew it through ETHRenewerV1',
    )
  })
})

describe('wrappedMigrationFlags', () => {
  test('returns no wrapped assumptions for an unwrapped name', () => {
    expect(
      wrappedMigrationFlags({
        wrapped: false,
        kind: 'unwrapped',
        fuses: 0,
        tokenApproval: null,
        resolverOverrideProvided: false,
        subregistryOverrideProvided: false,
        controllerOverrideProvided: false,
        nameWrapper,
      }),
    ).toEqual([])
  })

  test('describes wrapped inference and locked-name hazards', () => {
    const flags = wrappedMigrationFlags({
      wrapped: true,
      kind: 'wrapped-locked',
      fuses: CANNOT_UNWRAP | CANNOT_SET_RESOLVER | CANNOT_APPROVE,
      tokenApproval: currentOwner,
      resolverOverrideProvided: true,
      subregistryOverrideProvided: true,
      controllerOverrideProvided: true,
      nameWrapper,
    })

    expect(flags.filter((flag) => flag.type === 'assumption').map((flag) => flag.code)).toEqual([
      'WRAPPED_STATUS_INFERRED',
      'MIGRATION_PATH_INFERRED',
      'SENDER_AUTHORIZATION_NOT_VERIFIED',
    ])
    expect(flags.filter((flag) => flag.type === 'warning').map((flag) => flag.code)).toEqual([
      'RESOLVER_PAYLOAD_IGNORED',
      'FROZEN_TOKEN_APPROVAL',
      'SUBREGISTRY_PAYLOAD_IGNORED',
      'CONTROLLER_OVERRIDE_UNVERIFIED',
    ])
    expect(flags.find((flag) => flag.code === 'RESOLVER_PAYLOAD_IGNORED')?.message).toContain(
      'ignore --resolver',
    )
  })

  test('does not report frozen approval when getApproved is zero', () => {
    const flags = wrappedMigrationFlags({
      wrapped: true,
      kind: 'wrapped-locked',
      fuses: CANNOT_UNWRAP | CANNOT_APPROVE,
      tokenApproval: zeroAddress,
      resolverOverrideProvided: false,
      subregistryOverrideProvided: false,
      controllerOverrideProvided: false,
      nameWrapper,
    })

    expect(flags.some((flag) => flag.code === 'FROZEN_TOKEN_APPROVAL')).toBe(false)
  })
})

describe('buildMigrationTransaction', () => {
  test('encodes an unwrapped name as an ERC721 transfer to the unlocked controller', () => {
    const tx = buildMigrationTransaction({
      kind: 'unwrapped',
      currentOwner,
      labelId,
      nodeId,
      nameWrapper,
      baseRegistrar,
      lockedController,
      unlockedController,
      migration,
    })
    const decoded = decodeFunctionData({ abi: baseRegistrarAbi, data: tx.data })

    expect(tx.to).toBe(baseRegistrar)
    expect(tx.controller).toBe(unlockedController)
    expect(tx.tokenStandard).toBe('ERC721')
    expect(decoded.functionName).toBe('safeTransferFrom')
    expect(decoded.args).toEqual([currentOwner, unlockedController, labelId, tx.payload])
    expect(decodeMigrationPayload(tx.payload)).toEqual(migration)
  })

  test.each([
    ['wrapped-unlocked', unlockedController],
    ['wrapped-locked', lockedController],
  ] as const)('encodes %s as an ERC1155 transfer to its controller', (kind, controller) => {
    const tx = buildMigrationTransaction({
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
    const decoded = decodeFunctionData({ abi: nameWrapperAbi, data: tx.data })

    expect(tx.to).toBe(nameWrapper)
    expect(tx.controller).toBe(controller)
    expect(tx.tokenStandard).toBe('ERC1155')
    expect(decoded.functionName).toBe('safeTransferFrom')
    expect(decoded.args).toEqual([currentOwner, controller, nodeId, 1n, tx.payload])
    expect(decodeMigrationPayload(tx.payload)).toEqual(migration)
  })
})
