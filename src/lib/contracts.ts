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
    name: 'ETH_REGISTRY',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
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

/** ICompositeResolver: implemented by ENSv2's ENSV1Resolver bridge to expose the mirrored resolver. */
export const compositeResolverAbi = parseAbi([
  'function getResolver(bytes name) view returns (address resolver, bool offchain)',
])

export const ensRegistryAbi = parseAbi([
  'function owner(bytes32 node) external view returns (address)',
  'function resolver(bytes32 node) external view returns (address)',
  'function setResolver(bytes32 node, address resolver) external',
  'function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl) external',
])

export const universalResolverAbi = parseAbi([
  'function supportsInterface(bytes4 interfaceId) external view returns (bool)',
  'function isENSv2() external view returns (bool)',
  'function ROOT_REGISTRY() external view returns (address)',
  'function findResolver(bytes name) external view returns (address resolver, bytes32 node, uint256 offset)',
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
  'function initialize((address account, uint256 roleBitmap)[] grants) external',
])

export const verifiableFactoryAbi = parseAbi([
  'function proxyLogic() external view returns (address)',
  'function deployProxy(address implementation, uint256 salt, bytes data) external returns (address)',
])

export const permissionedResolverAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls) external',
  'function supportsInterface(bytes4 interfaceId) external view returns (bool)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes) external',
  'function setText(bytes name, string key, string value) external',
  'function setContenthash(bytes name, bytes hash) external',
])

// Shared by ETHRegistrar and ETHRenewerV1.
export const ethRenewerAbi = parseAbi([
  'function renew((string label, uint64 duration, bytes32 referrer) data, address paymentToken) external',
  'function getRenewPrice(string label, uint64 duration, address paymentToken) external view returns (uint256)',
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
    // 2026-10-18 deployment (first deployed 2026-10-02). Only used
    // once the Universal Resolver reports ENSv2, so this is inert until cutover.
    v2: {
      registrar: '0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81',
      renewerV1: '0x56c447F308F463A01121C41E72b0E7e7557fCb68',
      paymentToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      resolverFactory: '0x77510ba162dfeA3d8989E3f0928a691B345730D2',
      resolverImplementation: '0x565b0F456a04Ac9b48758190e90030623Cff57C5',
      subregistryImplementation: '0x75FF9AdBcFcE2469B097AC68f6Ae650EaE1351Bb',
      lockedMigrationController: '0xc46Bf3B6C7eBcFFd4EcfC3b012a1726a2463694d',
      unlockedMigrationController: '0xaB821Ca676CF2e0790Fa273526a165CFa86aEB64',
    },
  },
  sepolia: {
    registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    baseRegistrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    controller: '0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968',
    resolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
    universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
    nameWrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
    // 2026-10-01 deployment (contracts-v2 07e55a05).
    v2: {
      registrar: '0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3',
      renewerV1: '0xf2ece44980778966b8a0FccB3A9E339440f6e045',
      paymentToken: '0x240b0316Df57887DBBE58b586508b19e633a14aa',
      resolverFactory: '0xDa70306C98E97eCe36F997a21368e53298572991',
      resolverImplementation: '0x115eb53F0c60696633855F90b138178Fb40b2b2C',
      subregistryImplementation: '0x9BD8a88719068D09ecee662f36C0E3856708366a',
      lockedMigrationController: '0x6029a063d69b09D23c52a754a90E4FE43aDac3A8',
      unlockedMigrationController: '0x2a35B94DF22cc7354570be2284655E2CDC0e64A2',
    },
  },
} as const

export type Chain = keyof typeof addresses
