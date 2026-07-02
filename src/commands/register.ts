import { Cli, z } from 'incur'
import { zeroAddress } from 'viem'
import { encodeFunctionData, getAddress, toHex } from 'viem/utils'
import { ethRegistrarAbi, ethRegistrarControllerAbi, addresses } from '../lib/contracts.ts'
import { globalOptions, globalEnv, clientFromContext, activeV2Deployment } from '../lib/context.ts'
import { extractLabel, durationFromOption } from '../lib/utils.ts'
import {
  buildRegistration,
  computeV1Commitment,
  computeV2Commitment,
  resolveV1RegistrationParams,
  resolveV2RegistrationParams,
  validateSecretBytes32,
  validateWeiValue,
  verifyCommitmentAtReveal,
} from '../lib/register.ts'

function generateSecret(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

const durationOption = z.coerce
  .number()
  .int()
  .positive()
  .optional()
  .describe('Registration duration in seconds (default: 31536000 = 1 year)')

export const registerCommands = Cli.create('register', {
  description: 'ENS name registration (commit/reveal flow)',
})
  .command('commit', {
    description:
      'Generate the commitment transaction for registering an ENS name. Returns calldata JSON and a secret that MUST be saved for the reveal step. Wait at least 60 seconds after the commit transaction is mined before calling reveal.',
    args: z.object({
      name: z.string().describe('ENS name to register (e.g. myname.eth)'),
    }),
    options: globalOptions.merge(
      z.object({
        owner: z.string().describe('Address that will own the name'),
        duration: durationOption,
        secret: z.string().optional().describe('Secret bytes32 hex (auto-generated if omitted)'),
        resolver: z
          .string()
          .optional()
          .describe(
            'Resolver address (defaults to chain public resolver on ENSv1; on ENSv2, defaults to the owner owned resolver if deployed, otherwise zero address).',
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
        reverseRecord: z.boolean().optional().describe('Set reverse record (default: false)'),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client, chain } = clientFromContext(c)
      const label = extractLabel(c.args.name)
      const owner = getAddress(c.options.owner)
      const duration = durationFromOption(c.options.duration)
      const secret = c.options.secret ? validateSecretBytes32(c.options.secret) : generateSecret()
      const v2Deployment = await activeV2Deployment(c)

      if (v2Deployment) {
        const v2Params = await resolveV2RegistrationParams(client, v2Deployment, owner, c.options)

        const commitment = await computeV2Commitment(
          client,
          v2Deployment.registrar,
          label,
          owner,
          secret,
          v2Params,
          duration,
        )

        const data = encodeFunctionData({
          abi: ethRegistrarAbi,
          functionName: 'commit',
          args: [commitment],
        })

        const resolverHint =
          v2Params.resolver === zeroAddress
            ? `Optional: deploy a per-account resolver with: ens resolver deploy ${owner} --chain ${chain}, then re-run commit/reveal with --resolver <addr>.`
            : undefined

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
          resolver: v2Params.resolver,
          resolverSource: v2Params.resolverSource,
          subregistry: v2Params.subregistry,
          paymentToken: v2Params.paymentToken,
          referrer: v2Params.referrer,
          registry: v2Deployment.registry,
          registrar: v2Deployment.registrar,
          version: 'v2',
          resolverHint,
          nextSteps: [
            '1. Broadcast this commit transaction',
            '2. Wait at least 60 seconds after the tx is mined',
            `3. Run: ens price ${c.args.name} --chain ${chain} --paymentToken ${v2Params.paymentToken}`,
            `4. Approve ${v2Deployment.registrar} to spend the total ERC-20 price`,
            `5. Run: ens register reveal ${c.args.name} --owner ${owner} --chain ${chain} --secret ${secret} --paymentToken ${v2Params.paymentToken} --resolver ${v2Params.resolver}`,
          ],
        }
      }

      const controllerAddress = addresses[chain].controller
      const v1Params = resolveV1RegistrationParams(chain, c.options)

      const registration = buildRegistration({
        label,
        owner,
        duration,
        secret,
        resolver: v1Params.resolver,
        reverseRecord: v1Params.reverseRecord,
      })

      const commitment = await computeV1Commitment(client, controllerAddress, registration)

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
        resolver: v1Params.resolver,
        reverseRecord: v1Params.reverseRecord,
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
        duration: durationOption.describe('Registration duration in seconds (must match commit)'),
        resolver: z
          .string()
          .optional()
          .describe(
            'Resolver address (must match commit; defaults to deployed owner owned resolver on ENSv2, otherwise zero)',
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
        reverseRecord: z.boolean().optional().describe('Set reverse record (must match commit)'),
        skipCommitmentCheck: z
          .boolean()
          .optional()
          .describe('Skip onchain commitment verification (default: false)'),
      }),
    ),
    env: globalEnv,
    async run(c) {
      const { client, chain } = clientFromContext(c)
      const label = extractLabel(c.args.name)
      const owner = getAddress(c.options.owner)
      const duration = durationFromOption(c.options.duration)
      const secret = validateSecretBytes32(c.options.secret)
      const skipCommitmentCheck = c.options.skipCommitmentCheck ?? false
      const v2Deployment = await activeV2Deployment(c)

      if (v2Deployment) {
        const v2Params = await resolveV2RegistrationParams(client, v2Deployment, owner, c.options)

        const commitment = await computeV2Commitment(
          client,
          v2Deployment.registrar,
          label,
          owner,
          secret,
          v2Params,
          duration,
        )

        const commitmentVerification = await verifyCommitmentAtReveal({
          client,
          skipCommitmentCheck,
          version: 'v2',
          contractAddress: v2Deployment.registrar,
          commitment,
        })

        const data = encodeFunctionData({
          abi: ethRegistrarAbi,
          functionName: 'register',
          args: [
            label,
            owner,
            secret,
            v2Params.subregistry,
            v2Params.resolver,
            duration,
            v2Params.paymentToken,
            v2Params.referrer,
          ],
        })

        return {
          to: v2Deployment.registrar,
          data,
          value: '0',
          name: c.args.name,
          label,
          owner,
          duration: duration.toString(),
          resolver: v2Params.resolver,
          resolverSource: v2Params.resolverSource,
          subregistry: v2Params.subregistry,
          paymentToken: v2Params.paymentToken,
          referrer: v2Params.referrer,
          registry: v2Deployment.registry,
          registrar: v2Deployment.registrar,
          version: 'v2',
          ...commitmentVerification,
          note: commitmentVerification.commitmentCheckSkipped
            ? `Commitment check skipped. Approve ${v2Deployment.registrar} to spend the ERC-20 total from ens price before broadcasting this transaction.`
            : `Approve ${v2Deployment.registrar} to spend the ERC-20 total from ens price before broadcasting this transaction.`,
        }
      }

      if (c.options.value == null) {
        throw new Error('ENSv1 reveal requires --value <bufferedTotal from ens price>')
      }
      const value = validateWeiValue(c.options.value)

      const controllerAddress = addresses[chain].controller
      const v1Params = resolveV1RegistrationParams(chain, c.options)

      const registration = buildRegistration({
        label,
        owner,
        duration,
        secret,
        resolver: v1Params.resolver,
        reverseRecord: v1Params.reverseRecord,
      })

      const commitment = await computeV1Commitment(client, controllerAddress, registration)

      const commitmentVerification = await verifyCommitmentAtReveal({
        client,
        skipCommitmentCheck,
        version: 'v1',
        contractAddress: controllerAddress,
        commitment,
      })

      const data = encodeFunctionData({
        abi: ethRegistrarControllerAbi,
        functionName: 'register',
        args: [registration],
      })

      return {
        to: controllerAddress,
        data,
        value,
        name: c.args.name,
        label,
        owner,
        duration: duration.toString(),
        resolver: v1Params.resolver,
        reverseRecord: v1Params.reverseRecord,
        ...commitmentVerification,
        ...(commitmentVerification.commitmentCheckSkipped
          ? { note: 'Commitment check skipped.' }
          : {}),
      }
    },
  })
