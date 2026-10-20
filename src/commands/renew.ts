import { Cli, z } from 'incur'
import { zeroHash } from 'viem'
import { encodeFunctionData, getAddress } from 'viem/utils'
import { ethRegistrarControllerAbi, ethRenewerAbi, addresses } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext, renewalTarget } from '../lib/context.ts'
import { extractLabel, asHex, durationFromOption } from '../lib/utils.ts'

export const renewCommand = Cli.create('renew', {
  description: 'Generate renewal transaction calldata for an ENS name.',
  hint: 'Fetch "ens price <name> --renew" immediately before sending. ENSv1 requires --value bufferedTotal in ETH. ENSv2 uses an ERC-20 allowance and sends no ETH; unmigrated reserved names use ETHRenewerV1.',
  args: z.object({
    name: z.string().describe('ENS name to renew (e.g. myname.eth)'),
  }),
  options: globalOptions.merge(
    z.object({
      value: z
        .string()
        .optional()
        .describe(
          'ETH value in wei to send (use bufferedTotal from ens price, fetched immediately before this step)',
        ),
      duration: z.coerce
        .number()
        .optional()
        .describe('Renewal duration in seconds (default: 31536000 = 1 year)'),
      referrer: z.string().optional().describe('Referrer bytes32 hex (default: zero bytes32)'),
      paymentToken: z
        .string()
        .optional()
        .describe('ENSv2 ERC-20 payment token (default: chain v2 payment token)'),
    }),
  ),
  env: globalEnv,
  async run(c) {
    const { chain } = clientFromContext(c)
    const controllerAddress = addresses[chain].controller
    const label = extractLabel(c.args.name)
    const duration = durationFromOption(c.options.duration)
    const referrer = c.options.referrer ? asHex(c.options.referrer, 'referrer') : zeroHash

    const target = await renewalTarget(c, label)
    if (target) {
      if (c.options.value != null && BigInt(c.options.value) !== 0n) {
        throw new Error('ENSv2 renewals use an ERC-20 payment token. Do not send ETH value.')
      }
      const paymentToken = c.options.paymentToken
        ? getAddress(c.options.paymentToken)
        : target.deployment.paymentToken
      const data = encodeFunctionData({
        abi: ethRenewerAbi,
        functionName: 'renew',
        args: [{ label, duration, referrer }, paymentToken],
      })
      return {
        to: target.address,
        data,
        value: '0',
        name: c.args.name,
        label,
        duration: duration.toString(),
        referrer,
        paymentToken,
        version: 'v2',
        note: `Fetch "ens price ${label}.eth --renew --duration ${duration} --chain ${chain} --payment-token ${paymentToken}" and approve ${target.address} to spend total before sending.`,
      }
    }
    if (c.options.paymentToken != null)
      throw new Error('--payment-token requires an active ENSv2 deployment')
    if (c.options.value == null)
      throw new Error(
        `ENSv1 renewal requires --value from "ens price ${c.args.name} --renew --duration ${duration}"`,
      )

    const data = encodeFunctionData({
      abi: ethRegistrarControllerAbi,
      functionName: 'renew',
      args: [label, duration, referrer],
    })

    return {
      to: controllerAddress,
      data,
      value: c.options.value,
      name: c.args.name,
      label,
      duration: duration.toString(),
      referrer,
    }
  },
})
