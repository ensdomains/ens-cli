import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, zeroAddress } from 'viem'
import { baseRegistrarAbi, nameWrapperAbi } from '../lib/contracts.ts'
import {
  CANNOT_UNWRAP,
  buildMigrationTransaction,
  classifyMigration,
  decodeMigrationPayload,
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
