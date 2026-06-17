import { Cli, z } from 'incur'
import { ethRegistrarAbi, ethRegistrarControllerAbi, addresses } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext, activeV2Deployment } from '../lib/context.ts'
import { extractLabel } from '../lib/utils.ts'

export const availableCommand = Cli.create('available', {
  description: 'Check if an ENS name is available for registration',
  args: z.object({
    name: z.string().describe('ENS name to check (e.g. myname.eth)'),
  }),
  options: globalOptions,
  env: globalEnv,
  async run(c) {
    const { client, chain } = clientFromContext(c)
    const label = extractLabel(c.args.name)
    const v2Deployment = await activeV2Deployment(c)

    if (v2Deployment) {
      const available = await client.readContract({
        address: v2Deployment.registrar,
        abi: ethRegistrarAbi,
        functionName: 'isAvailable',
        args: [label],
      })
      return {
        name: c.args.name,
        label,
        available,
        registry: v2Deployment.registry,
        registrar: v2Deployment.registrar,
        version: 'v2',
      }
    }

    const available = await client.readContract({
      address: addresses[chain].controller,
      abi: ethRegistrarControllerAbi,
      functionName: 'available',
      args: [label],
    })
    return { name: c.args.name, label, available }
  },
})
