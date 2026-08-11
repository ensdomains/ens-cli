import { Cli, z } from 'incur'
import { zeroAddress, zeroHash } from 'viem'
import { encodeFunctionData, getAddress, toHex } from 'viem/utils'
import { ethRegistrarAbi, ethRegistrarControllerAbi, addresses } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext, activeV2Deployment } from '../lib/context.ts'
import { extractLabel, asHex, durationFromOption } from '../lib/utils.ts'
import { resolveDeployedOwnedResolver } from '../lib/v2.ts'

function generateSecret(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

type Registration = {
  label: string
  owner: `0x${string}`
  duration: bigint
  secret: `0x${string}`
  resolver: `0x${string}`
  data: readonly `0x${string}`[]
  reverseRecord: number
  referrer: `0x${string}`
}

function buildRegistration(opts: {
  label: string
  owner: `0x${string}`
  duration: bigint
  secret: `0x${string}`
  resolver: `0x${string}`
  reverseRecord: boolean
}): Registration {
  return {
    label: opts.label,
    owner: opts.owner,
    duration: opts.duration,
    secret: opts.secret,
    resolver: opts.resolver,
    data: [],
    reverseRecord: opts.reverseRecord ? 1 : 0,
    referrer: zeroHash,
  }
}

export const registerCommands = Cli.create('register', {
  description: 'ENS name registration (commit/reveal flow)',
})
  .command('commit', {
    description:
      'Generate the commitment transaction for registering an ENS name. Returns calldata JSON and a secret that MUST be saved for the reveal step. Wait at least 60 seconds after the commit transaction is mined before calling reveal.',
    hint: 'Do not commit with the zero resolver unless a resolverless name is intentional. On ENSv2, omitting --resolver may produce zero when the owner has no deployed OwnedResolver. In that case, first run "ens resolver deploy <owner> --name <name> --records <json>", then pass its predicted resolver address explicitly to both commit and reveal. The resolver can be deployed during the commitment wait. --reverse-record only applies during ENSv1 registration; use "ens set name <name>" after ENSv2 registration.',
    args: z.object({
      name: z.string().describe('ENS name to register (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(
      z.object({
        owner: z.string().describe('Address that will own the name'),
        duration: z.coerce
          .number()
          .optional()
          .describe('Registration duration in seconds (default: 31536000 = 1 year)'),
        secret: z.string().optional().describe('Secret bytes32 hex (auto-generated if omitted)'),
        resolver: z
          .string()
          .optional()
          .describe(
            'Resolver address. ENSv1 defaults to the chain public resolver. ENSv2 uses the owner\'s deployed OwnedResolver when available, but otherwise uses zero address (no resolver); generate one with "ens resolver deploy" and pass its predicted address explicitly.',
          ),
        subregistry: z
          .string()
          .optional()
          .describe('ENSv2 initial subregistry address (default: zero address)'),
        paymentToken: z
          .string()
          .optional()
          .describe('ENSv2 ERC-20 payment token (default: chain v2 payment token)'),
        referrer: z.string().optional().describe('Referrer bytes32 hex (default: zero bytes32)'),
        reverseRecord: z
          .boolean()
          .optional()
          .describe(
            'ENSv1 only: request a reverse record (default: false). Does not deploy/select a resolver or set ENSv2 forward resolution; use "ens set name" after ENSv2 registration.',
          ),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client, chain } = clientFromContext(c)
      const label = extractLabel(c.args.name)
      const owner = getAddress(c.options.owner)
      const duration = durationFromOption(c.options.duration)
      const secret = c.options.secret ? asHex(c.options.secret, 'secret') : generateSecret()
      const v2Deployment = await activeV2Deployment(c)

      if (v2Deployment) {
        const subregistry = c.options.subregistry ? getAddress(c.options.subregistry) : zeroAddress
        const resolver = c.options.resolver
          ? getAddress(c.options.resolver)
          : await resolveDeployedOwnedResolver({
              client,
              factory: v2Deployment.resolverFactory,
              proxyLogic: v2Deployment.resolverProxyLogic,
              owner,
            })
        const paymentToken = c.options.paymentToken
          ? getAddress(c.options.paymentToken)
          : v2Deployment.paymentToken
        const referrer = c.options.referrer ? asHex(c.options.referrer, 'referrer') : zeroHash

        const commitment = await client.readContract({
          address: v2Deployment.registrar,
          abi: ethRegistrarAbi,
          functionName: 'makeCommitment',
          args: [label, owner, secret, subregistry, resolver, duration, referrer],
        })

        const data = encodeFunctionData({
          abi: ethRegistrarAbi,
          functionName: 'commit',
          args: [commitment],
        })

        const resolverHint =
          resolver === zeroAddress
            ? `WARNING: This commitment registers ${c.args.name} with no resolver. Do not broadcast it unless that is intentional. Run: ens resolver deploy ${owner} --name ${c.args.name} --records '[{"type":"address","address":"${owner}"}]' --chain ${chain}. Then re-run commit with --resolver <returned resolver> and pass that same address to reveal.`
            : undefined
        const reverseRecordHint = c.options.reverseRecord
          ? `--reverse-record is ENSv1-only and is ignored for ENSv2. It does not deploy/select a resolver or create forward resolution; run "ens set name ${c.args.name}" after registration instead.`
          : undefined
        const nextSteps =
          resolver === zeroAddress
            ? [
                '1. Do not broadcast this commitment unless a resolverless registration is intentional.',
                `2. Run: ens resolver deploy ${owner} --name ${c.args.name} --records '[{"type":"address","address":"${owner}"}]' --chain ${chain}`,
                '3. Re-run commit with --resolver <returned resolver>. Use that exact resolver again on reveal.',
              ]
            : [
                '1. Broadcast this commit transaction',
                '2. Wait at least 60 seconds after the tx is mined',
                `3. Run: ens price ${c.args.name} --chain ${chain} --paymentToken ${paymentToken}`,
                `4. Approve ${v2Deployment.registrar} to spend the total ERC-20 price`,
                `5. Run: ens register reveal ${c.args.name} --owner ${owner} --chain ${chain} --secret ${secret} --paymentToken ${paymentToken} --resolver ${resolver}`,
              ]

        return {
          to: v2Deployment.registrar,
          data,
          value: '0',
          secret,
          commitment,
          name: c.args.name,
          label,
          owner,
          duration: duration.toString(),
          resolver,
          resolverSource:
            c.options.resolver != null
              ? 'option'
              : resolver === zeroAddress
                ? 'none'
                : 'ownedResolver',
          subregistry,
          paymentToken,
          referrer,
          registry: v2Deployment.registry,
          registrar: v2Deployment.registrar,
          version: 'v2',
          resolverHint,
          reverseRecordHint,
          nextSteps,
        }
      }

      const controllerAddress = addresses[chain].controller
      const resolver = c.options.resolver
        ? getAddress(c.options.resolver)
        : addresses[chain].resolver
      const reverseRecord = c.options.reverseRecord ?? false

      const registration = buildRegistration({
        label,
        owner,
        duration,
        secret,
        resolver,
        reverseRecord,
      })

      const commitment = await client.readContract({
        address: controllerAddress,
        abi: ethRegistrarControllerAbi,
        functionName: 'makeCommitment',
        args: [registration],
      })

      const data = encodeFunctionData({
        abi: ethRegistrarControllerAbi,
        functionName: 'commit',
        args: [commitment],
      })

      return {
        to: controllerAddress,
        data,
        value: '0',
        secret,
        commitment,
        name: c.args.name,
        label,
        owner,
        duration: duration.toString(),
        resolver,
        reverseRecord,
        nextSteps: [
          '1. Broadcast this commit transaction',
          '2. Wait at least 60 seconds after the tx is mined',
          `3. Run: ens price ${c.args.name} -- IMPORTANT: fetch price immediately before reveal, not earlier, because the required ETH amount changes with the ETH/USD price`,
          `4. Run: ens register reveal ${c.args.name} --owner ${owner} --secret ${secret} --value <bufferedTotal from price>`,
        ],
      }
    },
  })
  .command('reveal', {
    description:
      'Generate the registration transaction to reveal a committed ENS name. Requires the secret from the commit step and a value (in wei) from the price command.',
    hint: 'Pass the exact same --resolver value used for commit; do not rely on resolver auto-detection across the two steps. A commitment made with the zero resolver cannot gain one at reveal—you must deploy/predict a resolver and create a new commitment. --reverse-record is ENSv1-only; use "ens set name <name>" after ENSv2 registration.',
    args: z.object({
      name: z.string().describe('ENS name to register (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(
      z.object({
        owner: z.string().describe('Address that will own the name'),
        secret: z.string().describe('Secret from the commit step (required)'),
        value: z
          .string()
          .optional()
          .describe(
            'ENSv1 ETH value in wei to send (use bufferedTotal from ens price, fetched immediately before this step)',
          ),
        duration: z.coerce
          .number()
          .optional()
          .describe('Registration duration in seconds (must match commit)'),
        resolver: z
          .string()
          .optional()
          .describe(
            'Resolver address (must exactly match commit). On ENSv2, pass it explicitly; if omitted, auto-detection may differ from commit and invalidate the reveal.',
          ),
        subregistry: z
          .string()
          .optional()
          .describe('ENSv2 initial subregistry address (must match commit)'),
        paymentToken: z
          .string()
          .optional()
          .describe('ENSv2 ERC-20 payment token (must be approved before reveal)'),
        referrer: z.string().optional().describe('Referrer bytes32 hex (must match commit)'),
        reverseRecord: z
          .boolean()
          .optional()
          .describe(
            'ENSv1 only: request the reverse record made in the commit. Does not deploy/select an ENSv2 resolver; use "ens set name" after ENSv2 registration.',
          ),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client, chain } = clientFromContext(c)
      const label = extractLabel(c.args.name)
      const owner = getAddress(c.options.owner)
      const duration = durationFromOption(c.options.duration)
      const secret = asHex(c.options.secret, 'secret')
      const v2Deployment = await activeV2Deployment(c)

      if (v2Deployment) {
        const subregistry = c.options.subregistry ? getAddress(c.options.subregistry) : zeroAddress
        const resolver = c.options.resolver
          ? getAddress(c.options.resolver)
          : await resolveDeployedOwnedResolver({
              client,
              factory: v2Deployment.resolverFactory,
              proxyLogic: v2Deployment.resolverProxyLogic,
              owner,
            })
        const paymentToken = c.options.paymentToken
          ? getAddress(c.options.paymentToken)
          : v2Deployment.paymentToken
        const referrer = c.options.referrer ? asHex(c.options.referrer, 'referrer') : zeroHash
        const resolverHint =
          resolver === zeroAddress
            ? 'WARNING: This reveal registers the name with no resolver. The resolver must exactly match the commitment; if zero was unintentional, deploy/predict an OwnedResolver and make a new commitment with its address.'
            : undefined
        const reverseRecordHint = c.options.reverseRecord
          ? `--reverse-record is ENSv1-only and is ignored for ENSv2; run "ens set name ${c.args.name}" after registration instead.`
          : undefined

        const data = encodeFunctionData({
          abi: ethRegistrarAbi,
          functionName: 'register',
          args: [label, owner, secret, subregistry, resolver, duration, paymentToken, referrer],
        })

        return {
          to: v2Deployment.registrar,
          data,
          value: '0',
          name: c.args.name,
          label,
          owner,
          duration: duration.toString(),
          resolver,
          resolverSource:
            c.options.resolver != null
              ? 'option'
              : resolver === zeroAddress
                ? 'none'
                : 'ownedResolver',
          subregistry,
          paymentToken,
          referrer,
          registry: v2Deployment.registry,
          registrar: v2Deployment.registrar,
          version: 'v2',
          resolverHint,
          reverseRecordHint,
          note: `Approve ${v2Deployment.registrar} to spend the ERC-20 total from ens price before broadcasting this transaction.`,
        }
      }

      if (c.options.value == null) {
        throw new Error('ENSv1 reveal requires --value <bufferedTotal from ens price>')
      }

      const controllerAddress = addresses[chain].controller
      const resolver = c.options.resolver
        ? getAddress(c.options.resolver)
        : addresses[chain].resolver
      const reverseRecord = c.options.reverseRecord ?? false

      const registration = buildRegistration({
        label,
        owner,
        duration,
        secret,
        resolver,
        reverseRecord,
      })

      const data = encodeFunctionData({
        abi: ethRegistrarControllerAbi,
        functionName: 'register',
        args: [registration],
      })

      return {
        to: controllerAddress,
        data,
        value: c.options.value,
        name: c.args.name,
        label,
        owner,
        duration: duration.toString(),
      }
    },
  })
