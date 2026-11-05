import { z } from 'incur'
import { getAddress, isAddress } from 'viem/utils'
import { toCoinType } from 'viem/ens'

export const coinTypeOptions = z.object({
  coinType: z.coerce.number().optional().describe('ENSIP-9 coin type (60=ETH, 0=BTC)'),
  chainId: z.coerce
    .number()
    .optional()
    .describe('EVM chain ID — auto-converts to ENSIP-9 coin type (e.g. 10 for Optimism)'),
})

export function resolveCoinType(opts: { coinType?: number; chainId?: number }): number | undefined {
  if (opts.coinType != null && opts.chainId != null) {
    throw new Error('Cannot specify both --coin-type and --chain-id. Use one or the other.')
  }
  if (opts.chainId != null) {
    return Number(toCoinType(opts.chainId))
  }
  return opts.coinType
}

// ENSIP-11: EVM chains use coin types with the high bit set. These ENSIP-9 coin types
// predate it: Ethereum, Ethereum Classic, Gnosis (xDAI), and Polygon.
const EVM_COIN_TYPE_FLAG = 0x8000_0000
const LEGACY_EVM_COIN_TYPES = new Set([60, 61, 700, 966])

export function isEvmCoinType(coinType: number | undefined) {
  return coinType == null || LEGACY_EVM_COIN_TYPES.has(coinType) || coinType >= EVM_COIN_TYPE_FLAG
}

/** Checksums EVM addresses, which resolve as raw bytes for coin types other than 60. */
export function formatResolvedAddress(address: string | null, coinType: number | undefined) {
  if (address == null) return address
  return isEvmCoinType(coinType) && isAddress(address, { strict: false })
    ? getAddress(address)
    : address
}
