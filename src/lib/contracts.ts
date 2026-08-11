import { parseAbi } from 'viem/utils'

export const ethRegistrarControllerAbi = [
  {
    name: 'commit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'register',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'registration',
        type: 'tuple',
        components: [
          { name: 'label', type: 'string' },
          { name: 'owner', type: 'address' },
          { name: 'duration', type: 'uint256' },
          { name: 'secret', type: 'bytes32' },
          { name: 'resolver', type: 'address' },
          { name: 'data', type: 'bytes[]' },
          { name: 'reverseRecord', type: 'uint8' },
          { name: 'referrer', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: 'renew',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'duration', type: 'uint256' },
      { name: 'referrer', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'rentPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [
      {
        name: 'price',
        type: 'tuple',
        components: [
          { name: 'base', type: 'uint256' },
          { name: 'premium', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'available',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'label', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'makeCommitment',
    type: 'function',
    stateMutability: 'pure',
    inputs: [
      {
        name: 'registration',
        type: 'tuple',
        components: [
          { name: 'label', type: 'string' },
          { name: 'owner', type: 'address' },
          { name: 'duration', type: 'uint256' },
          { name: 'secret', type: 'bytes32' },
          { name: 'resolver', type: 'address' },
          { name: 'data', type: 'bytes[]' },
          { name: 'reverseRecord', type: 'uint8' },
          { name: 'referrer', type: 'bytes32' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const ethRegistrarAbi = [
  {
    name: 'commit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'secret', type: 'bytes32' },
      { name: 'subregistry', type: 'address' },
      { name: 'resolver', type: 'address' },
      { name: 'duration', type: 'uint64' },
      { name: 'paymentToken', type: 'address' },
      { name: 'referrer', type: 'bytes32' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    name: 'getRegisterPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'duration', type: 'uint64' },
      { name: 'paymentToken', type: 'address' },
    ],
    outputs: [
      { name: 'base', type: 'uint256' },
      { name: 'premium', type: 'uint256' },
    ],
  },
  {
    name: 'isAvailable',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'label', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'makeCommitment',
    type: 'function',
    stateMutability: 'pure',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'secret', type: 'bytes32' },
      { name: 'subregistry', type: 'address' },
      { name: 'resolver', type: 'address' },
      { name: 'duration', type: 'uint64' },
      { name: 'referrer', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

export const publicResolverAbi = [
  {
    name: 'setAddr',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'addr', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'setAddr',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'coinType', type: 'uint256' },
      { name: 'addr', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'setText',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'setContenthash',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'hash', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'multicall',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const

export const reverseRegistrarAbi = parseAbi([
  'function setName(string name) external returns (bytes32)',
])

export const baseRegistrarAbi = parseAbi([
  'function nameExpires(uint256 id) external view returns (uint256)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data) external',
])

export const ensRegistryAbi = parseAbi([
  'function owner(bytes32 node) external view returns (address)',
  'function resolver(bytes32 node) external view returns (address)',
  'function setResolver(bytes32 node, address resolver) external',
  'function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl) external',
])

export const universalResolverAbi = parseAbi([
  'function findCanonicalRegistry(bytes name) external view returns (address)',
  'function findResolver(bytes name) external view returns ((address resolver, bytes32 node, uint256 offset))',
  'error DNSDecodingFailed(bytes dns)',
  'error LabelIsTooLong(string label)',
  'error LabelIsEmpty()',
])

export const v2RegistryAbi = parseAbi([
  'function getState(uint256 anyId) external view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function getSubregistry(string label) external view returns (address)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expires) external returns (uint256 tokenId)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function setResolver(uint256 anyId, address resolver) external',
  'function setSubregistry(uint256 tokenId, address registry) external',
])

export const userRegistryAbi = parseAbi([
  'function initialize(address rootAccount, uint256 roleBitmap) external',
])

export const verifiableFactoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) external returns (address)',
])

export const permissionedResolverAbi = parseAbi([
  'function initialize(address admin, uint256 roleBitmap, bytes[] setters) external',
])

export const nameWrapperAbi = parseAbi([
  'function ownerOf(uint256 id) external view returns (address)',
  'function getData(uint256 id) external view returns (address owner, uint32 fuses, uint64 expiry)',
  'function getApproved(uint256 id) external view returns (address)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data) external',
  'function setResolver(bytes32 node, address resolver) external',
  'function setSubnodeRecord(bytes32 parentNode, string label, address owner, address resolver, uint64 ttl, uint32 fuses, uint64 expiry) external returns (bytes32)',
])

export const addresses = {
  mainnet: {
    registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    baseRegistrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    controller: '0x59E16fcCd424Cc24e280Be16E11Bcd56fb0CE547',
    resolver: '0xF29100983E058B709F3D539b0c765937B804AC15',
    universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
    nameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
  },
  sepolia: {
    registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    baseRegistrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    controller: '0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968',
    resolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
    universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
    nameWrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
    // Canonical ENSv2 deployment from 2026-07-30 (contracts-v2 PR #388).
    v2: {
      registry: '0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2',
      registrar: '0xa88553F454b77203B0D036A05c894d555EAAa2Cc',
      paymentToken: '0x768F42455A2D082E23ceeF7d51e5787C82d67a39',
      resolverFactory: '0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef',
      resolverImplementation: '0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e',
      resolverProxyLogic: '0xA136BeE4E37B44586242e516a39893EfD54315e9',
      subregistryImplementation: '0x624a25d67B59D587752EbEc8DdeD8827dAe52050',
      lockedMigrationController: '0x5c39E36a69A9897F08954c71aCB1F36E0Bd4f409',
      unlockedMigrationController: '0x2FCf83232b93bD29C59dB18AaA1D4b62e9f9FC73',
    },
  },
} as const

export type Chain = keyof typeof addresses
