import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { erc20Abi, parseAbi, type Address } from 'viem'
import { labelhash, namehash } from 'viem/ens'
import { addresses } from '../src/lib/contracts.ts'
import { freshLabel, startFork, type Fork } from './harness.ts'

setDefaultTimeout(180_000)

const v1 = addresses.mainnet
const v2 = addresses.mainnet.v2
// contracts-v2 mainnet UniversalResolverV2, used to simulate the ENSv2 cutover.
const V2_UNIVERSAL_RESOLVER = '0x06fdd07f007adac667177b46ab2eb9a75132cfd5'
const V2_ETH_REGISTRY = '0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2'
const YEAR = 31_536_000n

const baseRegistrarAbi = parseAbi([
  'function nameExpires(uint256 id) view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved)',
])
const nameWrapperAbi = parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function wrapETH2LD(string label, address wrappedOwner, uint16 ownerControlledFuses, address resolver) returns (uint64)',
])
const ensRegistryAbi = parseAbi(['function resolver(bytes32 node) view returns (address)'])
const universalResolverAbi = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function isENSv2() view returns (bool)',
])
const v2RegistryAbi = parseAbi([
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
])
// Mainnet was deployed with deferV2Registrar; the deployer grants these roles at launch.
const V2_DEPLOYER = '0x85a73f63309128d53928ee891e6e11e2b4695c20'
const ROLE_REGISTRAR = 1n << 0n
const ROLE_RENEW = 1n << 16n

let fork: Fork

beforeAll(async () => {
  fork = await startFork({
    chain: 'mainnet',
    forkUrl: process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
    forkBlock: process.env.MAINNET_FORK_BLOCK,
  })
})

afterAll(() => fork?.stop())

function v1Expiry(label: string) {
  return fork.client.readContract({
    address: v1.baseRegistrar,
    abi: baseRegistrarAbi,
    functionName: 'nameExpires',
    args: [BigInt(labelhash(label))],
  })
}

function registryResolver(name: string) {
  return fork.client.readContract({
    address: v1.registry,
    abi: ensRegistryAbi,
    functionName: 'resolver',
    args: [namehash(name)],
  })
}

async function registerV1(owner: Address, name: string, ...options: string[]) {
  const commit = await fork.ens('register', 'commit', name, '--owner', owner, ...options)
  await fork.send(owner, commit)
  await fork.advance(70)
  const price = await fork.ens('price', name)
  const reveal = await fork.ens(
    'register',
    'reveal',
    name,
    '--owner',
    owner,
    '--secret',
    commit.secret,
    '--value',
    price.bufferedTotal,
    ...options,
  )
  await fork.send(owner, reveal)
  return commit
}

describe('ENSv1 on mainnet (ENSv2 not active)', () => {
  let owner: Address
  const label = freshLabel('e2e')
  const name = `${label}.eth`

  beforeAll(async () => {
    // These tests describe mainnet before the cutover; fail loudly once that is no longer true.
    // Same check as the CLI: v1 Universal Resolvers can also advertise the interface.
    const ur = { address: v1.universalResolver, abi: universalResolverAbi } as const
    const v2Live =
      (await fork.client.readContract({
        ...ur,
        functionName: 'supportsInterface',
        args: ['0xfe0badd6'],
      })) && (await fork.client.readContract({ ...ur, functionName: 'isENSv2' }))
    if (v2Live) throw new Error('ENSv2 is live on mainnet; update the ENSv1 suite in this file')
    owner = await fork.account()
  })

  test('ENSv2-only commands refuse to run before the cutover', async () => {
    await expect(fork.ens('resolver', 'deploy', owner)).rejects.toThrow('ENSv2 is not active')
    await expect(fork.ens('migrate', 'nick.eth')).rejects.toThrow('not active')
    await expect(
      fork.ens('subregistry', 'deploy', 'nick.eth', '--deployer', owner),
    ).rejects.toThrow('not active')
    await expect(fork.ens('subregistry', 'set', 'nick.eth', '--registry', owner)).rejects.toThrow(
      'not active',
    )
  })

  test('available and price quote in ETH', async () => {
    expect(await fork.ens('available', name)).toMatchObject({ available: true })
    const price = await fork.ens('price', name)
    expect(BigInt(price.bufferedTotal)).toBeGreaterThan(BigInt(price.total))
    expect(price.version).toBeUndefined()
  })

  test('register commit and reveal pay in ETH through the v1 controller', async () => {
    const commit = await registerV1(owner, name, '--reverse-record')
    expect(commit).toMatchObject({ to: v1.controller, resolver: v1.resolver, reverseRecord: true })

    expect(await fork.ens('whois', name)).toMatchObject({ owner, resolver: v1.resolver })
    // The reverse record only verifies once the name also resolves forward to the owner.
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name: null })
    await fork.send(owner, await fork.ens('set', 'address', name, '--address', owner))
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name })
    expect(await fork.ens('available', name)).toMatchObject({ available: false })
  })

  test('set records on the public resolver and read them back', async () => {
    await fork.send(owner, await fork.ens('set', 'address', name, '--address', owner))
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: owner })

    await fork.send(
      owner,
      await fork.ens('set', 'text', name, '--key', 'url', '--value', 'https://ens.domains'),
    )
    expect(await fork.ens('get', 'text', name, '--key', 'url')).toMatchObject({
      value: 'https://ens.domains',
    })

    const contenthash = await fork.ens(
      'set',
      'contenthash',
      name,
      '--hash',
      '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f',
    )
    expect(contenthash.to).toBe(v1.resolver)
    await fork.send(owner, contenthash)

    const batch = JSON.stringify([
      { type: 'text', key: 'com.github', value: 'ensdomains' },
      { type: 'address', address: owner, chainId: 10 },
    ])
    await fork.send(owner, await fork.ens('set', 'batch', name, '--data', batch))
    expect(await fork.ens('get', 'text', name, '--key', 'com.github')).toMatchObject({
      value: 'ensdomains',
    })
    const optimism = await fork.ens('get', 'address', name, '--chain-id', '10')
    expect(optimism.address.toLowerCase()).toBe(owner.toLowerCase())
  })

  test('set encodes v1 setters for --resolver targets without ERC-165', async () => {
    // An EOA returns no data and the v1 registry reverts on supportsInterface.
    for (const resolver of [owner, v1.registry]) {
      const tx = await fork.ens(
        'set',
        'text',
        name,
        '--key',
        'k',
        '--value',
        'v',
        '--resolver',
        resolver,
      )
      expect(tx.to.toLowerCase()).toBe(resolver.toLowerCase())
      expect(tx.data.slice(0, 10)).toBe('0x10f13a8c') // setText(bytes32,string,string)
    }
  })

  test('set name sets and clears the primary name', async () => {
    await fork.send(owner, await fork.ens('set', 'name', name))
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name })
    await fork.send(owner, await fork.ens('set', 'name', ''))
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name: null })
  })

  test('renew pays ETH to the v1 controller', async () => {
    const before = await v1Expiry(label)
    const price = await fork.ens('price', name, '--renew')
    expect(price.premium).toBe('0')
    const renew = await fork.ens('renew', name, '--value', price.bufferedTotal)
    expect(renew).toMatchObject({ to: v1.controller, value: price.bufferedTotal })
    await fork.send(owner, renew)
    expect((await v1Expiry(label)) - before).toBe(YEAR)
  })

  test('renew requires --value and rejects --payment-token on v1', async () => {
    await expect(fork.ens('renew', name)).rejects.toThrow('requires --value')
    await expect(
      fork.ens('renew', name, '--value', '1', '--payment-token', v2.paymentToken),
    ).rejects.toThrow('--payment-token requires an active ENSv2 deployment')
  })

  test('resolver set and subname create on an unwrapped name use the registry', async () => {
    const other = await fork.account()
    const setResolver = await fork.ens('resolver', 'set', name, '--resolver', other)
    expect(setResolver.to).toBe(v1.registry)
    await fork.send(owner, setResolver)
    expect(await registryResolver(name)).toBe(other)
    await fork.send(owner, await fork.ens('resolver', 'set', name, '--resolver', v1.resolver))

    const sub = `sub.${name}`
    const create = await fork.ens('subname', 'create', sub, '--owner', other)
    expect(create).toMatchObject({ to: v1.registry, wrapped: false, resolver: v1.resolver })
    await fork.send(owner, create)
    expect(await fork.ens('whois', sub)).toMatchObject({ owner: other, resolver: v1.resolver })
  })

  test('resolver set and subname create on a wrapped name use the NameWrapper', async () => {
    const wrappedLabel = freshLabel('e2ew')
    const wrapped = `${wrappedLabel}.eth`
    await registerV1(owner, wrapped)
    await fork.write(owner, v1.baseRegistrar, baseRegistrarAbi, 'setApprovalForAll', [
      v1.nameWrapper,
      true,
    ])
    await fork.write(owner, v1.nameWrapper, nameWrapperAbi, 'wrapETH2LD', [
      wrappedLabel,
      owner,
      0,
      v1.resolver,
    ])

    const other = await fork.account()
    const setResolver = await fork.ens('resolver', 'set', wrapped, '--resolver', other)
    expect(setResolver.to).toBe(v1.nameWrapper)
    await fork.send(owner, setResolver)
    expect(await registryResolver(wrapped)).toBe(other)
    await fork.send(owner, await fork.ens('resolver', 'set', wrapped, '--resolver', v1.resolver))

    const sub = `sub.${wrapped}`
    const create = await fork.ens('subname', 'create', sub, '--owner', other)
    expect(create).toMatchObject({ to: v1.nameWrapper, wrapped: true })
    await fork.send(owner, create)
    expect(
      await fork.client.readContract({
        address: v1.nameWrapper,
        abi: nameWrapperAbi,
        functionName: 'ownerOf',
        args: [BigInt(namehash(sub))],
      }),
    ).toBe(other)

    // Records on a wrapped name are authorized through the NameWrapper.
    await fork.send(
      owner,
      await fork.ens('set', 'text', wrapped, '--key', 'e2e', '--value', 'wrapped'),
    )
    expect(await fork.ens('get', 'text', wrapped, '--key', 'e2e')).toMatchObject({
      value: 'wrapped',
    })
  })

  test('get reads existing mainnet names', async () => {
    const address = await fork.ens('get', 'address', 'nick.eth')
    expect(address.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(await fork.ens('get', 'name', address.address)).toMatchObject({ name: 'nick.eth' })
    expect((await fork.ens('get', 'text', 'nick.eth', '--key', 'url')).value).toBeTruthy()
    expect((await fork.ens('get', 'avatar', 'nick.eth')).avatar).toBeTruthy()
  })
})

describe('ENSv2 on mainnet after the cutover (simulated with --universal-resolver)', () => {
  const ur = ['--universal-resolver', V2_UNIVERSAL_RESOLVER]
  let owner: Address
  const name = `${freshLabel('e2e')}.eth`

  beforeAll(async () => {
    owner = await fork.account()
    await fork.fund(V2_DEPLOYER)
    await fork.write(V2_DEPLOYER, V2_ETH_REGISTRY, v2RegistryAbi, 'grantRootRoles', [
      ROLE_REGISTRAR | ROLE_RENEW,
      v2.registrar,
    ])
  })

  test('detection switches every command to the configured mainnet deployment', async () => {
    expect(await fork.ens('available', name, ...ur)).toMatchObject({
      available: true,
      version: 'v2',
      registrar: v2.registrar,
      registry: V2_ETH_REGISTRY,
    })
    expect(await fork.ens('price', name, ...ur)).toMatchObject({
      version: 'v2',
      paymentToken: v2.paymentToken,
      tokenSymbol: 'USDC',
    })
  })

  test('resolver deploy, register and records work against the mainnet contracts', async () => {
    const deploy = await fork.ens(
      'resolver',
      'deploy',
      owner,
      ...ur,
      '--name',
      name,
      '--records',
      JSON.stringify([{ type: 'address', address: owner, coinType: 60 }]),
    )
    expect(deploy.to).toBe(v2.resolverFactory)
    await fork.send(owner, deploy)

    const commit = await fork.ens('register', 'commit', name, '--owner', owner, ...ur)
    expect(commit).toMatchObject({ to: v2.registrar, resolver: deploy.resolver })
    await fork.send(owner, commit)
    await fork.advance(70)

    const price = await fork.ens('price', name, ...ur)
    await fork.client.request({
      method: 'anvil_dealERC20' as any,
      params: [owner, v2.paymentToken, `0x${BigInt(price.total).toString(16)}`] as any,
    })
    await fork.write(owner, v2.paymentToken, erc20Abi, 'approve', [
      v2.registrar,
      BigInt(price.total),
    ])
    const reveal = await fork.ens(
      'register',
      'reveal',
      name,
      '--owner',
      owner,
      '--secret',
      commit.secret,
      '--resolver',
      deploy.resolver,
      ...ur,
    )
    await fork.send(owner, reveal)

    expect(await fork.ens('whois', name, ...ur)).toMatchObject({
      owner,
      resolver: deploy.resolver,
      registry: V2_ETH_REGISTRY,
      status: 'REGISTERED',
    })
    expect(await fork.ens('get', 'address', name, ...ur)).toMatchObject({ address: owner })
    expect(await fork.ens('renew', name, ...ur)).toMatchObject({ to: v2.registrar })
  })

  test('reserved v1 names renew through the mainnet ETHRenewerV1', async () => {
    expect(await fork.ens('price', 'nick.eth', '--renew', ...ur)).toMatchObject({
      registrar: v2.renewerV1,
    })
  })
})
