import { Cli, z } from 'incur'
import { zeroHash } from 'viem'
import { encodeFunctionData, getAddress } from 'viem/utils'
import { ethRegistrarAbi, ethRegistrarControllerAbi, addresses } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext, activeV2Deployment } from '../lib/context.ts'
import { extractLabel, asHex, durationFromOption } from '../lib/utils.ts'

export const renewCommand = Cli.create('renew', {
  description: 'Generate renewal transaction calldata for an ENS name.',
  hint: 'Requires --value from ens price, fetched immediately before sending because the required ETH amount changes with the ETH/USD price.',
  args: z.object({
    name: z.string().describe('ENS name to renew (e.g. myname.eth)'),
  }),
  options: globalOptions.merge(
    z.object({
      value: z
        .string()
        .describe(
          'ETH value in wei to send (use bufferedTotal from ens price, fetched immediately before this step)',
        ),
      duration: z.coerce
        .number()
        .optional()
        .describe('Renewal duration in seconds (default: 31536000 = 1 year)'),
      paymentToken: z
        .string()
        .optional()
        .describe('ENSv2 ERC-20 payment token (default: chain v2 payment token)'),
      referrer: z.string().optional().describe('Referrer bytes32 hex (default: zero bytes32)'),
    }),
  ),
  env: globalEnv,
  async run(c) {
    const { chain } = clientFromContext(c)
    const label = extractLabel(c.args.name)
    const duration = durationFromOption(c.options.duration)
    const referrer = c.options.referrer ? asHex(c.options.referrer, 'referrer') : zeroHash
    const v2Deployment = await activeV2Deployment(c)

    if (v2Deployment) {
      const paymentToken = c.options.paymentToken
        ? getAddress(c.options.paymentToken)
        : v2Deployment.paymentToken

      const data = encodeFunctionData({
        abi: ethRegistrarAbi,
        functionName: 'renew',
        args: [label, duration, paymentToken, referrer],
      })

      return {
        to: v2Deployment.registrar,
        data,
        value: '0',
        name: c.args.name,
        label,
        duration: duration.toString(),
        paymentToken,
        referrer,
        registry: v2Deployment.registry,
        registrar: v2Deployment.registrar,
        version: 'v2',
        note: `Approve ${v2Deployment.registrar} to spend the ERC-20 total from ens price before broadcasting this transaction.`,
      }
    }

    const value = c.options.value
    if (!/^[0-9]+$/.test(value)) {
      throw new Error('--value must be a base-10 unsigned integer string (wei)')
    }

    const controllerAddress = addresses[chain].controller

    const data = encodeFunctionData({
      abi: ethRegistrarControllerAbi,
      functionName: 'renew',
      args: [label, duration, referrer],
    })

    return {
      to: controllerAddress,
      data,
      value,
      name: c.args.name,
      label,
      duration: duration.toString(),
      referrer,
    }
  },
})
