import { Cli, z } from 'incur'
import { formatEther, formatUnits, getAddress } from 'viem/utils'
import { erc20Abi } from 'viem'
import {
  ethRegistrarAbi,
  ethRegistrarControllerAbi,
  ethRenewerAbi,
  addresses,
} from '../lib/contracts.ts'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  activeV2Deployment,
  renewalTarget,
} from '../lib/context.ts'
import { extractLabel, durationFromOption } from '../lib/utils.ts'

export const priceCommand = Cli.create('price', {
  description: 'Check the registration or renewal cost for an ENS name.',
  hint: 'Use --renew for renewal pricing. Fetch immediately before sending. ENSv1 uses bufferedTotal as ETH value; ENSv2 requires an ERC-20 allowance for total and no ETH value.',
  args: z.object({
    name: z.string().describe('ENS name to price (e.g. myname.eth)'),
  }),
  options: globalOptions.merge(
    z.object({
      duration: z.coerce
        .number()
        .optional()
        .describe('Registration or renewal duration in seconds (default: 31536000 = 1 year)'),
      renew: z.boolean().optional().describe('Quote renewal instead of registration'),
      paymentToken: z.string().optional().describe('ERC-20 payment token for ENSv2 pricing'),
    }),
  ),
  env: globalEnv,
  async run(c) {
    const { client, chain } = clientFromContext(c)
    const label = extractLabel(c.args.name)
    const duration = durationFromOption(c.options.duration)
    const renewal = c.options.renew ? await renewalTarget(c, label) : undefined
    const v2Deployment = c.options.renew ? renewal?.deployment : await activeV2Deployment(c)

    if (v2Deployment) {
      const paymentToken = c.options.paymentToken
        ? getAddress(c.options.paymentToken)
        : v2Deployment.paymentToken
      const registrar = renewal?.address ?? v2Deployment.registrar
      const [base, premium] = renewal
        ? ([
            await client.readContract({
              address: registrar,
              abi: ethRenewerAbi,
              functionName: 'getRenewPrice',
              args: [label, duration, paymentToken],
            }),
            0n,
          ] as const)
        : await client.readContract({
            address: v2Deployment.registrar,
            abi: ethRegistrarAbi,
            functionName: 'getRegisterPrice',
            args: [label, duration, paymentToken],
          })
      const total = base + premium

      let symbol: string | null = null
      let decimals: number | null = null
      try {
        ;[symbol, decimals] = await Promise.all([
          client.readContract({
            address: paymentToken,
            abi: erc20Abi,
            functionName: 'symbol',
          }),
          client.readContract({
            address: paymentToken,
            abi: erc20Abi,
            functionName: 'decimals',
          }),
        ])
      } catch {
        // Some ERC-20s omit metadata. Raw amounts are still returned below.
      }

      const result = {
        name: c.args.name,
        label,
        duration: duration.toString(),
        base: base.toString(),
        premium: premium.toString(),
        total: total.toString(),
        paymentToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        totalFormatted: decimals == null ? null : formatUnits(total, decimals),
        registry: v2Deployment.registry,
        registrar,
        version: 'v2',
        operation: c.options.renew ? 'renewal' : 'registration',
        note: `ENSv2 ${c.options.renew ? 'renewal' : 'registration'} is paid with an ERC-20. Approve ${registrar} to spend total, then call ${c.options.renew ? 'renew' : 'register reveal'} with the same paymentToken. Do not send ETH value.`,
      }

      if (
        chain === 'sepolia' &&
        paymentToken.toLowerCase() === v2Deployment.paymentToken.toLowerCase()
      ) {
        return {
          ...result,
          testTokenHint:
            'Sepolia uses a dummy USDC ERC-20 for ENSv2 testing. It has open minting, so mint test tokens before approving the registrar.',
          testTokenMint: {
            token: paymentToken,
            function: 'mint(address,uint256)',
            amount: total.toString(),
            amountFormatted: decimals == null ? null : formatUnits(total, decimals),
            example: `cast send ${paymentToken} "mint(address,uint256)" <your-address> ${total.toString()} --rpc-url <sepolia-rpc> --private-key <key>`,
          },
        }
      }

      return result
    }

    const price = await client.readContract({
      address: addresses[chain].controller,
      abi: ethRegistrarControllerAbi,
      functionName: 'rentPrice',
      args: [label, duration],
    })
    // ETHRegistrarController.renew charges rentPrice(...).base only.
    const premium = c.options.renew ? 0n : price.premium
    const total = price.base + premium
    const buffered = total + total / 20n // 5% buffer for ETH price changes
    return {
      name: c.args.name,
      label,
      duration: duration.toString(),
      base: price.base.toString(),
      premium: premium.toString(),
      total: total.toString(),
      totalEth: formatEther(total),
      bufferedTotal: buffered.toString(),
      bufferedTotalEth: formatEther(buffered),
      note: 'bufferedTotal includes a 5% buffer to account for ETH price fluctuations. Use bufferedTotal as the value for register/renew transactions. Any excess ETH is refunded by the contract.',
    }
  },
})
