import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { encodeFunctionData, getAddress, isAddressEqual, isHex, toHex } from 'viem/utils'
import { labelhash, namehash } from 'viem/ens'
import {
  addresses,
  ensRegistryAbi,
  nameWrapperAbi,
  permissionedResolverAbi,
  v2RegistryAbi,
  verifiableFactoryAbi,
} from '../lib/contracts.ts'
import {
  globalOptions,
  globalEnv,
  clientFromContext,
  activeV2Deployment,
  v2DeploymentForChain,
} from '../lib/context.ts'
import { validateName, eth2ldLabel } from '../lib/utils.ts'
import { ALL_ROLES, computeOwnedResolverAddress, defaultOwnedResolverSalt } from '../lib/v2.ts'
import { encodeRecordOperation, parseRecordOperations } from '../lib/records.ts'

// ENSv2's EnhancedAccessControl packs each role into a 4-bit group, so a 1 in
// every nibble grants the admin all roles (ALL_ROLES in the ENSv2 contracts).
const DEFAULT_ROLE_BITMAP = ALL_ROLES

function parseSalt(salt: string | undefined, owner: `0x${string}`): bigint {
  if (salt) return BigInt(salt)
  return defaultOwnedResolverSalt(owner)
}

export const resolverCommands = Cli.create('resolver', {
  description: 'ENSv2 resolver utilities',
})
  .command('deploy', {
    description:
      'Generate calldata to deploy an OwnedResolver via the ENSv2 VerifiableFactory. The resolver address is determined by (factory, proxyLogic, deployer, salt) and must be deployed from the deployer address. If a resolver already exists at the predicted address, returns alreadyDeployed=true with no transaction needed.',
    hint: 'Use --name and --records together to initialize address, text, or contenthash records in the resolver deployment transaction, avoiding a later record-setting transaction. Initial records only work for a new resolver; use "ens set batch" when it is already deployed.',
    args: z.object({
      deployer: z
        .string()
        .describe(
          'Address that will send the deployment transaction. The resolver address depends on this — sending from a different account produces a different resolver.',
        ),
    }),
    options: globalOptions.merge(
      z.object({
        admin: z
          .string()
          .optional()
          .describe('Admin address granted role bitmap on the resolver (default: deployer)'),
        salt: z
          .string()
          .optional()
          .describe(
            'CREATE2 salt as decimal or 0x hex (default: keccak256(abi.encode(keccak256("OwnedResolver"), admin, 0)))',
          ),
        roleBitmap: z
          .string()
          .optional()
          .describe('Role bitmap granted to the admin as decimal or 0x hex (default: 0x1111…1111)'),
        name: z
          .string()
          .optional()
          .describe('ENS name whose records should be initialized (requires --records)'),
        records: z
          .string()
          .optional()
          .describe(
            'JSON array of initial record operations (requires --name; same format as ens set batch --data): [{"type":"text","key":"url","value":"https://..."},{"type":"address","address":"0x...","chainId":10},{"type":"address","address":"0x...","coinType":0},{"type":"contenthash","hash":"0x..."}]',
          ),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client, chain } = clientFromContext(c)
      const v2Deployment = v2DeploymentForChain(chain)
      if (!v2Deployment) {
        throw new Error(`ENSv2 resolver deployment is not configured for chain "${chain}"`)
      }

      const deployer = getAddress(c.args.deployer)
      const admin = c.options.admin ? getAddress(c.options.admin) : deployer
      const salt = parseSalt(c.options.salt, admin)
      const roleBitmap = c.options.roleBitmap ? BigInt(c.options.roleBitmap) : DEFAULT_ROLE_BITMAP
      if ((c.options.name == null) !== (c.options.records == null)) {
        throw new Error('--name and --records must be provided together')
      }
      const recordName = c.options.name == null ? undefined : validateName(c.options.name)
      const recordOperations =
        c.options.records == null ? [] : parseRecordOperations(c.options.records)
      if (c.options.records != null && recordOperations.length === 0) {
        throw new Error('--records must contain at least one record operation')
      }
      const recordNode = recordName == null ? undefined : namehash(recordName)
      const setters =
        recordNode == null
          ? []
          : recordOperations.map((operation) => encodeRecordOperation(recordNode, operation))

      const initializeData = encodeFunctionData({
        abi: permissionedResolverAbi,
        functionName: 'initialize',
        args: [admin, roleBitmap, setters],
      })
      const data = encodeFunctionData({
        abi: verifiableFactoryAbi,
        functionName: 'deployProxy',
        args: [v2Deployment.resolverImplementation, salt, initializeData],
      })
      const proxy = computeOwnedResolverAddress({
        factory: v2Deployment.resolverFactory,
        proxyLogic: v2Deployment.resolverProxyLogic,
        deployer,
        owner: admin,
        salt,
      })

      const code = await client.getCode({ address: proxy.address })
      const alreadyDeployed = isHex(code) && code !== '0x'
      if (alreadyDeployed && recordName != null) {
        throw new Error(
          `Resolver already deployed at ${proxy.address}; initial records can only be applied during deployment. Run "ens set batch ${recordName} --resolver ${proxy.address} --data <records-json>" instead.`,
        )
      }

      return {
        to: v2Deployment.resolverFactory,
        data,
        value: '0',
        resolver: proxy.address,
        alreadyDeployed,
        chain,
        factory: v2Deployment.resolverFactory,
        implementation: v2Deployment.resolverImplementation,
        proxyLogic: v2Deployment.resolverProxyLogic,
        deployer,
        admin,
        salt: salt.toString(),
        saltHex: toHex(salt, { size: 32 }),
        outerSalt: proxy.outerSalt,
        roleBitmap: roleBitmap.toString(),
        roleBitmapHex: toHex(roleBitmap, { size: 32 }),
        recordName,
        recordNode,
        records: recordOperations,
        setters,
        initializeData,
        nextSteps: alreadyDeployed
          ? [
              `Resolver already deployed at ${proxy.address}. No transaction needed.`,
              `Pass it as --resolver ${proxy.address} when registering, migrating, or creating a subname.`,
            ]
          : [
              `1. Broadcast this transaction from ${deployer}`,
              recordName == null
                ? `2. Confirm the resolver is live at ${proxy.address}`
                : `2. Confirm the resolver and initial records for ${recordName} are live at ${proxy.address}`,
              `3. Pass it as --resolver ${proxy.address} when registering, migrating, or creating a subname`,
            ],
      }
    },
  })
  .command('set', {
    description:
      'Generate calldata to change the resolver of an existing ENS name. Auto-routes between the v2 registry, the v1 NameWrapper (for wrapped names), and the v1 ENS registry (for unwrapped names).',
    args: z.object({
      name: z.string().describe('ENS name to update (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(
      z.object({
        resolver: z.string().describe('New resolver address'),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client, chain } = clientFromContext(c)
      const name = validateName(c.args.name)
      const resolver = getAddress(c.options.resolver)
      const v2Deployment = await activeV2Deployment(c)

      if (v2Deployment) {
        const label = eth2ldLabel(name)
        if (label == null) {
          throw new Error('ENSv2 resolver set currently only supports 2LD .eth names')
        }
        const anyId = BigInt(labelhash(label))

        const { status, latestOwner, tokenId } = await client.readContract({
          address: v2Deployment.registry,
          abi: v2RegistryAbi,
          functionName: 'getState',
          args: [anyId],
        })
        if (status !== 2) {
          throw new Error(
            `"${name}" is not registered on the v2 registry (status=${status}). Register it first via ens register.`,
          )
        }

        const data = encodeFunctionData({
          abi: v2RegistryAbi,
          functionName: 'setResolver',
          args: [anyId, resolver],
        })

        return {
          to: v2Deployment.registry,
          data,
          value: '0',
          name,
          label,
          resolver,
          registry: v2Deployment.registry,
          tokenId: tokenId.toString(),
          latestOwner,
          version: 'v2',
          note: 'Transaction must be sent from the name owner or an approved operator.',
        }
      }

      const registryAddress = addresses[chain].registry
      const nameWrapperAddress = addresses[chain].nameWrapper
      const node = namehash(name)

      const registryOwner = await client.readContract({
        address: registryAddress,
        abi: ensRegistryAbi,
        functionName: 'owner',
        args: [node],
      })

      if (registryOwner === zeroAddress) {
        throw new Error(
          `"${name}" has no owner in the ENS registry. A resolver cannot be set on an unowned name.`,
        )
      }

      const wrapped = isAddressEqual(registryOwner, nameWrapperAddress)

      if (wrapped) {
        const wrappedOwner = await client.readContract({
          address: nameWrapperAddress,
          abi: nameWrapperAbi,
          functionName: 'ownerOf',
          args: [BigInt(node)],
        })

        const data = encodeFunctionData({
          abi: nameWrapperAbi,
          functionName: 'setResolver',
          args: [node, resolver],
        })

        return {
          to: nameWrapperAddress,
          data,
          value: '0',
          name,
          node,
          resolver,
          owner: wrappedOwner,
          registryOwner,
          wrapped: true,
          version: 'v1',
          note: 'Name is wrapped — call NameWrapper.setResolver. Transaction must be sent from the wrapped owner (or an approved operator).',
        }
      }

      const data = encodeFunctionData({
        abi: ensRegistryAbi,
        functionName: 'setResolver',
        args: [node, resolver],
      })

      return {
        to: registryAddress,
        data,
        value: '0',
        name,
        node,
        resolver,
        owner: registryOwner,
        wrapped: false,
        version: 'v1',
        note: 'Transaction must be sent from the registry owner (or an approved operator).',
      }
    },
  })
