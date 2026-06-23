import { Cli, z } from 'incur'
import { zeroHash } from 'viem'
import { encodeFunctionData } from 'viem/utils'
import { ethRegistrarControllerAbi, addresses } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext } from '../lib/context.ts'
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
      referrer: z.string().optional().describe('Referrer bytes32 hex (default: zero bytes32)'),
    }),
  ),
  env: globalEnv,
  async run(c) {
    const { chain } = clientFromContext(c)
    const controllerAddress = addresses[chain].controller
    const label = extractLabel(c.args.name)
    const duration = durationFromOption(c.options.duration)
    const referrer = c.options.referrer ? asHex(c.options.referrer, 'referrer') : zeroHash

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
