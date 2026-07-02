import { zeroAddress, zeroHash } from 'viem'
import type { PublicClient } from 'viem'
import { getAddress } from 'viem/utils'
import { ethRegistrarAbi, ethRegistrarControllerAbi, addresses, type Chain } from './contracts.ts'
import { asHex } from './utils.ts'
import { resolveDeployedOwnedResolver } from './v2.ts'

export type Registration = {
  label: string
  owner: `0x${string}`
  duration: bigint
  secret: `0x${string}`
  resolver: `0x${string}`
  data: readonly `0x${string}`[]
  reverseRecord: number
  referrer: `0x${string}`
}

export type V2Deployment = (typeof addresses)['sepolia']['v2']

export type V2RegistrationOptions = {
  subregistry?: string
  resolver?: string
  paymentToken?: string
  referrer?: string
}

export type V2RegistrationParams = {
  subregistry: `0x${string}`
  resolver: `0x${string}`
  paymentToken: `0x${string}`
  referrer: `0x${string}`
  resolverSource: 'option' | 'none' | 'ownedResolver'
}

export type V1RegistrationOptions = {
  resolver?: string
  reverseRecord?: boolean
}

export type V1RegistrationParams = {
  resolver: `0x${string}`
  reverseRecord: boolean
}

export function buildRegistration(opts: {
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

export async function resolveV2RegistrationParams(
  client: PublicClient,
  v2Deployment: V2Deployment,
  owner: `0x${string}`,
  options: V2RegistrationOptions,
): Promise<V2RegistrationParams> {
  const subregistry = options.subregistry ? getAddress(options.subregistry) : zeroAddress
  const resolver = options.resolver
    ? getAddress(options.resolver)
    : await resolveDeployedOwnedResolver({
        client,
        factory: v2Deployment.resolverFactory,
        proxyLogic: v2Deployment.resolverProxyLogic,
        owner,
      })
  const paymentToken = options.paymentToken
    ? getAddress(options.paymentToken)
    : v2Deployment.paymentToken
  const referrer = options.referrer ? asHex(options.referrer, 'referrer') : zeroHash

  return {
    subregistry,
    resolver,
    paymentToken,
    referrer,
    resolverSource:
      options.resolver != null ? 'option' : resolver === zeroAddress ? 'none' : 'ownedResolver',
  }
}

export function resolveV1RegistrationParams(
  chain: Chain,
  options: V1RegistrationOptions,
): V1RegistrationParams {
  return {
    resolver: options.resolver ? getAddress(options.resolver) : addresses[chain].resolver,
    reverseRecord: options.reverseRecord ?? false,
  }
}

export function validateSecretBytes32(value: string): `0x${string}` {
  const hex = asHex(value, 'secret')
  if (hex.length !== 66) {
    throw new Error(
      `Invalid secret: expected 32-byte hex (0x + 64 hex chars), got ${hex.length - 2} bytes`,
    )
  }
  return hex
}

export function validateWeiValue(value: string): string {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `Invalid --value: expected base-10 unsigned integer string (wei), got "${value}"`,
    )
  }
  return value
}

export async function computeV1Commitment(
  client: PublicClient,
  controllerAddress: `0x${string}`,
  registration: Registration,
): Promise<`0x${string}`> {
  return client.readContract({
    address: controllerAddress,
    abi: ethRegistrarControllerAbi,
    functionName: 'makeCommitment',
    args: [registration],
  })
}

export async function computeV2Commitment(
  client: PublicClient,
  registrar: `0x${string}`,
  label: string,
  owner: `0x${string}`,
  secret: `0x${string}`,
  params: Pick<V2RegistrationParams, 'subregistry' | 'resolver' | 'referrer'>,
  duration: bigint,
): Promise<`0x${string}`> {
  return client.readContract({
    address: registrar,
    abi: ethRegistrarAbi,
    functionName: 'makeCommitment',
    args: [label, owner, secret, params.subregistry, params.resolver, duration, params.referrer],
  })
}

const NO_MATCHING_COMMITMENT_ERROR =
  'No matching commitment found onchain. The reveal parameters (owner, duration, secret, resolver, reverseRecord, referrer) must exactly match the commit step. If you used default values at commit time, conditions may have changed — pass all parameters explicitly.'

async function readCommitmentState(
  client: PublicClient,
  controllerAddress: `0x${string}`,
  commitment: `0x${string}`,
) {
  const [committedAt, minCommitmentAge, maxCommitmentAge, block] = await Promise.all([
    client.readContract({
      address: controllerAddress,
      abi: ethRegistrarControllerAbi,
      functionName: 'commitments',
      args: [commitment],
    }),
    client.readContract({
      address: controllerAddress,
      abi: ethRegistrarControllerAbi,
      functionName: 'minCommitmentAge',
    }),
    client.readContract({
      address: controllerAddress,
      abi: ethRegistrarControllerAbi,
      functionName: 'maxCommitmentAge',
    }),
    client.getBlock(),
  ])

  return {
    committedAt,
    minCommitmentAge,
    maxCommitmentAge,
    now: block.timestamp,
  }
}

async function assertCommitmentAge(
  client: PublicClient,
  controllerAddress: `0x${string}`,
  commitment: `0x${string}`,
) {
  const { committedAt, minCommitmentAge, maxCommitmentAge, now } = await readCommitmentState(
    client,
    controllerAddress,
    commitment,
  )

  if (committedAt === 0n) {
    throw new Error(NO_MATCHING_COMMITMENT_ERROR)
  }

  const age = now - committedAt
  if (age < minCommitmentAge) {
    const waitSeconds = Number(minCommitmentAge - age)
    throw new Error(
      `Commitment is too new. Wait ${waitSeconds} more second(s) before revealing (commitment ${commitment}, committed at ${committedAt}).`,
    )
  }

  if (age > maxCommitmentAge) {
    throw new Error(
      `Commitment has expired. Re-run register commit and wait before revealing (commitment ${commitment}, committed at ${committedAt}, max age ${maxCommitmentAge}s).`,
    )
  }

  return { committedAt, minCommitmentAge, maxCommitmentAge }
}

export async function registrarSupportsCommitmentGetters(
  client: PublicClient,
  registrar: `0x${string}`,
): Promise<boolean> {
  try {
    await Promise.all([
      client.readContract({
        address: registrar,
        abi: ethRegistrarControllerAbi,
        functionName: 'commitments',
        args: [zeroHash],
      }),
      client.readContract({
        address: registrar,
        abi: ethRegistrarControllerAbi,
        functionName: 'minCommitmentAge',
      }),
      client.readContract({
        address: registrar,
        abi: ethRegistrarControllerAbi,
        functionName: 'maxCommitmentAge',
      }),
    ])
    return true
  } catch {
    return false
  }
}

export type CommitmentVerificationOutput = {
  commitment: `0x${string}`
  committedAt?: string
  minCommitmentAge?: string
  maxCommitmentAge?: string
  commitmentCheckSkipped?: boolean
  warning?: string
}

export async function verifyCommitmentAtReveal(opts: {
  client: PublicClient
  skipCommitmentCheck: boolean
  version: 'v1' | 'v2'
  contractAddress: `0x${string}`
  commitment: `0x${string}`
}): Promise<CommitmentVerificationOutput> {
  const base = { commitment: opts.commitment }

  if (opts.skipCommitmentCheck) {
    return {
      ...base,
      commitmentCheckSkipped: true,
    }
  }

  if (opts.version === 'v1') {
    const { committedAt, minCommitmentAge, maxCommitmentAge } = await assertCommitmentAge(
      opts.client,
      opts.contractAddress,
      opts.commitment,
    )
    return {
      ...base,
      committedAt: committedAt.toString(),
      minCommitmentAge: minCommitmentAge.toString(),
      maxCommitmentAge: maxCommitmentAge.toString(),
    }
  }

  const supportsGetters = await registrarSupportsCommitmentGetters(
    opts.client,
    opts.contractAddress,
  )
  if (!supportsGetters) {
    return {
      ...base,
      warning:
        'Onchain commitment verification was skipped because this registrar does not expose commitments/minCommitmentAge/maxCommitmentAge. Recomputed commitment is included — ensure reveal parameters exactly match commit.',
    }
  }

  const { committedAt, minCommitmentAge, maxCommitmentAge } = await assertCommitmentAge(
    opts.client,
    opts.contractAddress,
    opts.commitment,
  )
  return {
    ...base,
    committedAt: committedAt.toString(),
    minCommitmentAge: minCommitmentAge.toString(),
    maxCommitmentAge: maxCommitmentAge.toString(),
  }
}
