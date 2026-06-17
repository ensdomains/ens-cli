import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddressEqual } from 'viem/utils'
import { v2RegistryAbi, userRegistryAbi, verifiableFactoryAbi } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext, activeV2Deployment } from '../lib/context.ts'
import { durationFromOption, validateName } from '../lib/utils.ts'
import {
  ALL_ROLES,
  V2_STATUS_REGISTERED,
  defaultUserRegistrySalt,
  formatSalt,
  getV2ParentRegistryForName,
  getV2RegistryForName,
  parseBigIntOption,
  v2LabelId,
} from '../lib/v2.ts'

function requiredAddress(
  value: string | undefined,
  fallback: `0x${string}` | undefined,
  optionName: string,
  description: string,
) {
  if (value) return getAddress(value)
  if (fallback) return fallback
  throw new Error(`${description} is not configured for this chain. Pass ${optionName} <address>.`)
}

async function simulateDeployProxyAddress(opts: {
  client: ReturnType<typeof clientFromContext>['client']
  factory: `0x${string}`
  deployer: `0x${string}`
  data: `0x${string}`
}) {
  try {
    const result = await opts.client.call({
      account: opts.deployer,
      to: opts.factory,
      data: opts.data,
    })
    if (!result.data || result.data === '0x') return undefined
    return decodeFunctionResult({
      abi: verifiableFactoryAbi,
      functionName: 'deployProxy',
      data: result.data,
    })
  } catch {
    return undefined
  }
}

export const subregistryCommands = Cli.create('subregistry', {
  description: 'ENSv2 subregistry utilities',
})
  .command('deploy', {
    description:
      'Generate calldata to deploy a UserRegistry subregistry for an ENSv2 name via the VerifiableFactory. If the name already has a subregistry, returns alreadySet=true with no deployment needed.',
    args: z.object({
      name: z.string().describe('ENSv2 name that will use this subregistry (e.g. parent.eth)'),
    }),
    options: globalOptions.merge(
      z.object({
        deployer: z
          .string()
          .describe(
            'Address that will send the deployment transaction. The subregistry address depends on this address.',
          ),
        admin: z.string().optional().describe('Deprecated alias for --root-account'),
        rootAccount: z
          .string()
          .optional()
          .describe('Address granted root roles on the UserRegistry (default: deployer)'),
        implementation: z
          .string()
          .optional()
          .describe(
            'UserRegistry implementation address (required unless configured for the chain)',
          ),
        salt: z
          .string()
          .optional()
          .describe(
            'CREATE2 salt as decimal or 0x hex (default: keccak256(abi.encode(keccak256("UserRegistry"), namehash(name), 0)))',
          ),
        roleBitmap: z
          .string()
          .optional()
          .describe('Root roles granted to root account as decimal or 0x hex (default: all roles)'),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client } = clientFromContext(c)
      const name = validateName(c.args.name)
      const v2Deployment = await activeV2Deployment(c)
      if (!v2Deployment) {
        throw new Error(
          `ENSv2 is not active or configured for chain "${c.options.chain ?? 'mainnet'}"`,
        )
      }

      const existing = await getV2RegistryForName({
        client,
        rootRegistry: v2Deployment.registry,
        name,
      })

      if (!isAddressEqual(existing.registry, zeroAddress)) {
        return {
          name,
          subregistry: existing.registry,
          registry: v2Deployment.registry,
          version: 'v2',
          alreadySet: true,
          note: `"${name}" already has a subregistry. No deployment needed.`,
        }
      }

      const deployer = getAddress(c.options.deployer)
      const rootAccount = c.options.rootAccount
        ? getAddress(c.options.rootAccount)
        : c.options.admin
          ? getAddress(c.options.admin)
          : deployer
      const implementation = requiredAddress(
        c.options.implementation,
        v2Deployment.subregistryImplementation,
        '--implementation',
        'UserRegistry implementation',
      )
      const salt = c.options.salt ? BigInt(c.options.salt) : defaultUserRegistrySalt(name)
      const roleBitmap = parseBigIntOption(c.options.roleBitmap, ALL_ROLES)

      const initializeData = encodeFunctionData({
        abi: userRegistryAbi,
        functionName: 'initialize',
        args: [rootAccount, roleBitmap],
      })
      const data = encodeFunctionData({
        abi: verifiableFactoryAbi,
        functionName: 'deployProxy',
        args: [implementation, salt, initializeData],
      })
      const subregistry = await simulateDeployProxyAddress({
        client,
        factory: v2Deployment.resolverFactory,
        deployer,
        data,
      })

      const code = subregistry ? await client.getCode({ address: subregistry }) : undefined
      const alreadyDeployed = code != null && code !== '0x'

      return {
        to: v2Deployment.resolverFactory,
        data,
        value: '0',
        name,
        subregistry,
        alreadyDeployed,
        alreadySet: false,
        version: 'v2',
        factory: v2Deployment.resolverFactory,
        implementation,
        deployer,
        rootAccount,
        ...formatSalt(salt),
        roleBitmap: roleBitmap.toString(),
        nextSteps:
          subregistry == null
            ? [
                `1. Broadcast this transaction from ${deployer}`,
                '2. Read the subregistry address from the ProxyDeployed event',
                `3. Run: ens subregistry set ${name} --registry <proxyAddress> --chain ${c.options.chain ?? 'mainnet'}`,
              ]
            : alreadyDeployed
              ? [
                  `Subregistry already deployed at ${subregistry}. No deploy transaction needed.`,
                  `Run: ens subregistry set ${name} --registry ${subregistry} --chain ${c.options.chain ?? 'mainnet'}`,
                ]
              : [
                  `1. Broadcast this transaction from ${deployer}`,
                  `2. Run: ens subregistry set ${name} --registry ${subregistry} --chain ${c.options.chain ?? 'mainnet'}`,
                ],
      }
    },
  })
  .command('set', {
    description:
      'Generate calldata to set the subregistry of an existing ENSv2 name. For 2LD .eth names this targets the .eth registry; for deeper names it targets the parent subregistry.',
    args: z.object({
      name: z.string().describe('ENSv2 name to update (e.g. parent.eth)'),
    }),
    options: globalOptions.merge(
      z.object({
        registry: z.string().describe('Subregistry address to set, or zero address to clear'),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client } = clientFromContext(c)
      const name = validateName(c.args.name)
      const subregistry = getAddress(c.options.registry)
      const v2Deployment = await activeV2Deployment(c)
      if (!v2Deployment) {
        throw new Error(
          `ENSv2 is not active or configured for chain "${c.options.chain ?? 'mainnet'}"`,
        )
      }

      const parent = await getV2ParentRegistryForName({
        client,
        rootRegistry: v2Deployment.registry,
        name,
      })

      if (isAddressEqual(parent.registry, zeroAddress)) {
        throw new Error(
          `Parent "${parent.parent}" has no ENSv2 subregistry, so "${name}" cannot be updated. Missing subregistry for "${parent.missingName}".`,
        )
      }

      const { status, latestOwner, tokenId } = await client.readContract({
        address: parent.registry,
        abi: v2RegistryAbi,
        functionName: 'getState',
        args: [v2LabelId(parent.label)],
      })

      if (status !== V2_STATUS_REGISTERED) {
        throw new Error(
          `"${name}" is not registered in its ENSv2 parent registry (status=${status}). Register it first.`,
        )
      }

      const data = encodeFunctionData({
        abi: v2RegistryAbi,
        functionName: 'setSubregistry',
        args: [tokenId, subregistry],
      })

      return {
        to: parent.registry,
        data,
        value: '0',
        name,
        label: parent.label,
        parent: parent.parent,
        parentRegistry: parent.registry,
        subregistry,
        tokenId: tokenId.toString(),
        latestOwner,
        version: 'v2',
        note: 'Transaction must be sent from the name owner or an approved operator with the set-subregistry role.',
      }
    },
  })
