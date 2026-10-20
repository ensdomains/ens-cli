import { z } from 'incur'
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  AbiDecodingDataSizeTooSmallError,
  type PublicClient,
} from 'viem'
import { encodeFunctionData, getAddress, toHex, toFunctionSelector } from 'viem/utils'
import { packetToBytes } from 'viem/ens'
import { permissionedResolverAbi, publicResolverAbi } from './contracts.ts'
import { resolveCoinType } from './cointype.ts'
import { asHex } from './utils.ts'

// IAddressSetter is advertised by the new record resolver. Detect the resolver,
// not the chain or name version: v1 and v2 resolver contracts coexist.
const V2_ADDRESS_SETTER_INTERFACE = toFunctionSelector('setAddress(bytes,uint256,bytes)')

export async function supportsV2RecordSetters(client: PublicClient, resolver: `0x${string}`) {
  try {
    return await client.readContract({
      address: resolver,
      abi: permissionedResolverAbi,
      functionName: 'supportsInterface',
      args: [V2_ADDRESS_SETTER_INTERFACE],
    })
  } catch (error) {
    // Legacy resolvers without ERC-165 revert or return nothing; RPC failures still throw.
    if (isUnsupportedCall(error)) return false
    throw error
  }
}

/** True when a contract call failed because the target lacks the function, not because of the RPC. */
export function isUnsupportedCall(error: unknown) {
  if (!(error instanceof BaseError)) return false
  if (
    error.walk(
      (e) =>
        e instanceof ContractFunctionZeroDataError || e instanceof AbiDecodingDataSizeTooSmallError,
    )
  )
    return true
  if (!error.walk((e) => e instanceof ContractFunctionRevertedError)) return false
  // viem also reports JSON-RPC internal errors (-32603) as reverts, so require
  // evidence from the node: the revert code, revert data, or a revert message.
  const rpc = error.walk() as BaseError & { code?: number; data?: unknown }
  return rpc.code === 3 || rpc.data != null || /revert/i.test(`${rpc.details} ${rpc.shortMessage}`)
}

export const recordOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('address'),
    address: z.string(),
    coinType: z.number().optional(),
    chainId: z.number().optional(),
  }),
  z.object({ type: z.literal('text'), key: z.string(), value: z.string() }),
  z.object({ type: z.literal('contenthash'), hash: z.string() }),
])

export type RecordOperation = z.infer<typeof recordOperationSchema>

export function parseRecordOperations(input: string): RecordOperation[] {
  return z.array(recordOperationSchema).parse(JSON.parse(input))
}

export function encodeRecordOperation(
  node: `0x${string}`,
  operation: RecordOperation,
): `0x${string}` {
  switch (operation.type) {
    case 'address': {
      const coinType = resolveCoinType(operation)
      if (coinType != null) {
        return encodeFunctionData({
          abi: publicResolverAbi,
          functionName: 'setAddr',
          args: [node, BigInt(coinType), asHex(operation.address, 'address')],
        })
      }
      return encodeFunctionData({
        abi: publicResolverAbi,
        functionName: 'setAddr',
        args: [node, getAddress(operation.address)],
      })
    }
    case 'text':
      return encodeFunctionData({
        abi: publicResolverAbi,
        functionName: 'setText',
        args: [node, operation.key, operation.value],
      })
    case 'contenthash':
      return encodeFunctionData({
        abi: publicResolverAbi,
        functionName: 'setContenthash',
        args: [node, asHex(operation.hash, 'contenthash')],
      })
  }
}

export function encodeV2RecordOperation(name: string, operation: RecordOperation): `0x${string}` {
  const dnsName = toHex(packetToBytes(name))
  switch (operation.type) {
    case 'address': {
      const coinType = resolveCoinType(operation) ?? 60
      // Empty bytes clear the record; otherwise ETH addresses are checksummed.
      const address =
        coinType === 60 && operation.address !== '0x'
          ? getAddress(operation.address)
          : asHex(operation.address, 'address')
      return encodeFunctionData({
        abi: permissionedResolverAbi,
        functionName: 'setAddress',
        args: [dnsName, BigInt(coinType), address],
      })
    }
    case 'text':
      return encodeFunctionData({
        abi: permissionedResolverAbi,
        functionName: 'setText',
        args: [dnsName, operation.key, operation.value],
      })
    case 'contenthash':
      return encodeFunctionData({
        abi: permissionedResolverAbi,
        functionName: 'setContenthash',
        args: [dnsName, asHex(operation.hash, 'contenthash')],
      })
  }
}
