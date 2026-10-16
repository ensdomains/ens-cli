import { z } from 'incur'
import type { PublicClient } from 'viem'
import { encodeFunctionData, getAddress, toHex, toFunctionSelector } from 'viem/utils'
import { packetToBytes } from 'viem/ens'
import { permissionedResolverAbi, publicResolverAbi } from './contracts.ts'
import { resolveCoinType } from './cointype.ts'
import { asHex } from './utils.ts'

// IAddressSetter is advertised by the new record resolver. Detect the resolver,
// not the chain or name version: v1 and v2 resolver contracts coexist.
const V2_ADDRESS_SETTER_INTERFACE = toFunctionSelector('setAddress(bytes,uint256,bytes)')

export function supportsV2RecordSetters(client: PublicClient, resolver: `0x${string}`) {
  return client.readContract({
    address: resolver,
    abi: permissionedResolverAbi,
    functionName: 'supportsInterface',
    args: [V2_ADDRESS_SETTER_INTERFACE],
  })
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
      const address =
        coinType === 60 ? getAddress(operation.address) : asHex(operation.address, 'address')
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
