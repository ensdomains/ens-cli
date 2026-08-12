import { z } from 'incur'
import { encodeFunctionData, getAddress } from 'viem/utils'
import { publicResolverAbi } from './contracts.ts'
import { resolveCoinType } from './cointype.ts'
import { asHex } from './utils.ts'

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
