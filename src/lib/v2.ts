import { zeroAddress } from 'viem'
import type { PublicClient } from 'viem'
import {
  concat,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  isHex,
  isAddressEqual,
  keccak256,
  stringToBytes,
  toHex,
} from 'viem/utils'
import { labelhash, namehash } from 'viem/ens'
import { v2RegistryAbi } from './contracts.ts'

export const V2_STATUS_REGISTERED = 2
export const ROLE_REGISTRAR = 1n << 0n
export const ROLE_REGISTER_RESERVED = 1n << 4n
export const ROLE_SET_PARENT = 1n << 8n
export const ROLE_UNREGISTER = 1n << 12n
export const ROLE_RENEW = 1n << 16n
export const ROLE_SET_SUBREGISTRY = 1n << 20n
export const ROLE_SET_RESOLVER = 1n << 24n
export const ROLE_SET_URI = 1n << 36n
export const ROLE_UPGRADE = 1n << 124n
export const ROLE_UNREGISTER_ADMIN = ROLE_UNREGISTER << 128n
export const ROLE_RENEW_ADMIN = ROLE_RENEW << 128n
export const ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128n
export const ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128n
export const V2_DEFAULT_OWNER_ROLE_BITMAP =
  ROLE_UNREGISTER |
  ROLE_RENEW |
  ROLE_SET_SUBREGISTRY |
  ROLE_SET_RESOLVER |
  ROLE_UNREGISTER_ADMIN |
  ROLE_RENEW_ADMIN |
  ROLE_SET_SUBREGISTRY_ADMIN |
  ROLE_SET_RESOLVER_ADMIN
// ENSv2 EAC packs legal roles into the low bit of each 4-bit nybble; this is
// the all-roles grant bitmap, not a locked-roles or fuse-style mask.
export const ALL_ROLES = BigInt(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
)
export const MAX_UINT64 = (1n << 64n) - 1n

const USER_REGISTRY_ID = keccak256(stringToBytes('UserRegistry'))
const USER_REGISTRY_VERSION = 0n
const OWNED_RESOLVER_ID = keccak256(stringToBytes('OwnedResolver'))
const OWNED_RESOLVER_VERSION = 0n

export function v2LabelId(label: string) {
  return BigInt(labelhash(label))
}

export function parseBigIntOption(value: string | undefined, fallback: bigint) {
  return value == null ? fallback : BigInt(value)
}

export function defaultUserRegistrySalt(name: string) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [USER_REGISTRY_ID, namehash(name), USER_REGISTRY_VERSION],
      ),
    ),
  )
}

export function defaultOwnedResolverSalt(owner: `0x${string}`) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [OWNED_RESOLVER_ID, owner, OWNED_RESOLVER_VERSION],
      ),
    ),
  )
}

export function computeOwnedResolverAddress(opts: {
  factory: `0x${string}`
  proxyLogic: `0x${string}`
  deployer: `0x${string}`
  owner: `0x${string}`
  salt?: bigint
}) {
  const salt = opts.salt ?? defaultOwnedResolverSalt(opts.owner)
  const outerSalt = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [opts.deployer, salt]),
  )
  const bytecode = concat([
    '0x3d604d80600a3d3981f3363d3d373d3d3d363d73',
    opts.proxyLogic,
    '0x5af43d82803e903d91602b57fd5bf3',
    outerSalt,
  ])

  return {
    address: getContractAddress({
      bytecode,
      from: opts.factory,
      opcode: 'CREATE2',
      salt: outerSalt,
    }),
    salt,
    outerSalt,
  }
}

export async function resolveDeployedOwnedResolver(opts: {
  client: PublicClient
  factory: `0x${string}`
  proxyLogic: `0x${string}`
  owner: `0x${string}`
}) {
  const proxy = computeOwnedResolverAddress({
    factory: opts.factory,
    proxyLogic: opts.proxyLogic,
    deployer: opts.owner,
    owner: opts.owner,
  })
  const code = await opts.client.getCode({ address: proxy.address })
  return isHex(code) && code !== '0x' ? proxy.address : zeroAddress
}

export function splitEnsName(name: string) {
  return name.split('.')
}

export function splitSubname(name: string): { label: string; parent: string } {
  const dot = name.indexOf('.')
  if (dot <= 0 || dot === name.length - 1) {
    throw new Error(
      `"${name}" is not a subname. Expected at least one label under a parent (e.g. sub.parent.eth).`,
    )
  }
  return { label: name.slice(0, dot), parent: name.slice(dot + 1) }
}

export function assertV2EthName(name: string) {
  const labels = splitEnsName(name)
  if (labels.length < 2 || labels[labels.length - 1] !== 'eth') {
    throw new Error(`ENSv2 commands currently only support names under .eth. Got: ${name}`)
  }
  return labels
}

export async function getV2RegistryForName(opts: {
  client: PublicClient
  rootRegistry: `0x${string}`
  name: string
}) {
  const labels = assertV2EthName(opts.name)
  let registry = getAddress(opts.rootRegistry)

  for (let i = labels.length - 2; i >= 0; i--) {
    const label = labels[i]!
    const subregistry = await opts.client.readContract({
      address: registry,
      abi: v2RegistryAbi,
      functionName: 'getSubregistry',
      args: [label],
    })

    if (isAddressEqual(subregistry, zeroAddress)) {
      return {
        registry: zeroAddress,
        missingLabel: label,
        missingName: labels.slice(i, labels.length).join('.'),
      }
    }

    registry = getAddress(subregistry)
  }

  return { registry, missingLabel: null, missingName: null }
}

export async function getV2ParentRegistryForName(opts: {
  client: PublicClient
  rootRegistry: `0x${string}`
  name: string
}) {
  const { label, parent } = splitSubname(opts.name)
  const parentLabels = splitEnsName(parent)
  if (parentLabels.length === 1 && parentLabels[0] === 'eth') {
    return {
      label,
      parent,
      registry: getAddress(opts.rootRegistry),
      missingLabel: null,
      missingName: null,
    }
  }

  const result = await getV2RegistryForName({
    client: opts.client,
    rootRegistry: opts.rootRegistry,
    name: parent,
  })

  return { label, parent, ...result }
}

export function formatSalt(salt: bigint) {
  return {
    salt: salt.toString(),
    saltHex: toHex(salt, { size: 32 }),
  }
}
