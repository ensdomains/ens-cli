import { z } from 'incur'
import { toCoinType } from 'viem/ens'

export const coinTypeOptions = z.object({
  coinType: z.coerce.number().optional().describe('ENSIP-9 coin type (e.g. 0 for BTC, 60 for ETH)'),
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
