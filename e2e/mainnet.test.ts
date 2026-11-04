import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { erc20Abi, parseAbi, zeroAddress, zeroHash, type Address } from 'viem'
import { labelhash } from 'viem/ens'
import { addresses } from '../src/lib/contracts.ts'
import { freshLabel, startFork, type Fork } from './harness.ts'

setDefaultTimeout(180_000)

const v1 = addresses.mainnet
const v2 = addresses.mainnet.v2
const ETH_REGISTRY = '0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2'
const YEAR = 31_536_000n
const CONTENTHASH = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const CANNOT_UNWRAP = 1

const registryAbi = parseAbi([
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function ownerOf(uint256 tokenId) view returns (address)',
])
const baseRegistrarAbi = parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function transferFrom(address from, address to, uint256 id)',
  'function approve(address to, uint256 id)',
])
const nameWrapperAbi = parseAbi([
  'function wrapETH2LD(string label, address owner, uint16 ownerControlledFuses, address resolver) returns (uint64)',
])

let fork: Fork

beforeAll(async () => {
  fork = await startFork({
    chain: 'mainnet',
    forkUrl: process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
  })
})

afterAll(() => fork?.stop())

function state(registry: Address, label: string) {
  return fork.client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: 'getState',
    args: [BigInt(labelhash(label))],
  })
}

/** Deals mainnet USDC to `payer` and approves `spender` for exactly `amount`. */
async function payFor(payer: Address, spender: Address, amount: bigint) {
  await fork.client.request({
    method: 'anvil_dealERC20' as any,
    params: [payer, v2.paymentToken, `0x${amount.toString(16)}`] as any,
  })
  await fork.write(payer, v2.paymentToken, erc20Abi, 'approve', [spender, amount])
}

describe('ENSv2 on mainnet', () => {
  let owner: Address
  let resolver: Address
  const label = freshLabel('e2e')
  const name = `${label}.eth`

  beforeAll(async () => {
    owner = await fork.account()
  })

  test('the Universal Resolver reports ENSv2 and matches the configured registrar', async () => {
    expect(await fork.ens('available', name)).toMatchObject({
      available: true,
      version: 'v2',
      registrar: v2.registrar,
      registry: ETH_REGISTRY,
    })
    expect(await fork.ens('price', name)).toMatchObject({
      version: 'v2',
      operation: 'registration',
      paymentToken: v2.paymentToken,
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      premium: '0',
    })
  })

  test('resolver deploy predicts and deploys an OwnedResolver with initial records', async () => {
    const deploy = await fork.ens(
      'resolver',
      'deploy',
      owner,
      '--name',
      name,
      '--records',
      JSON.stringify([{ type: 'address', address: owner, coinType: 60 }]),
    )
    expect(deploy).toMatchObject({ to: v2.resolverFactory, alreadyDeployed: false })
    resolver = deploy.resolver
    await fork.send(owner, deploy)
    expect(await fork.ens('resolver', 'deploy', owner)).toMatchObject({
      resolver,
      alreadyDeployed: true,
    })
  })

  test('register commit and reveal pay in USDC through ETHRegistrar', async () => {
    const commit = await fork.ens('register', 'commit', name, '--owner', owner)
    expect(commit).toMatchObject({ to: v2.registrar, resolver, resolverSource: 'ownedResolver' })
    await fork.send(owner, commit)
    await fork.advance(70)

    const price = await fork.ens('price', name)
    await payFor(owner, v2.registrar, BigInt(price.total))
    const reveal = await fork.ens(
      'register',
      'reveal',
      name,
      '--owner',
      owner,
      '--secret',
      commit.secret,
    )
    expect(reveal.value).toBe('0')
    await fork.send(owner, reveal)

    expect(await fork.ens('whois', name)).toMatchObject({
      owner,
      resolver,
      registry: ETH_REGISTRY,
      status: 'REGISTERED',
    })
    expect(await fork.ens('available', name)).toMatchObject({ available: false })
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: owner })
  })

  test('set records use the PermissionedResolver setters', async () => {
    await fork.send(
      owner,
      await fork.ens('set', 'text', name, '--key', 'url', '--value', 'https://ens.domains'),
    )
    expect(await fork.ens('get', 'text', name, '--key', 'url')).toMatchObject({
      value: 'https://ens.domains',
    })
    const contenthash = await fork.ens('set', 'contenthash', name, '--hash', CONTENTHASH)
    expect(contenthash.to).toBe(resolver)
    await fork.send(owner, contenthash)

    const batch = JSON.stringify([
      { type: 'text', key: 'com.github', value: 'ensdomains' },
      { type: 'address', address: owner, chainId: 10 },
    ])
    await fork.send(owner, await fork.ens('set', 'batch', name, '--data', batch))
    expect(await fork.ens('get', 'text', name, '--key', 'com.github')).toMatchObject({
      value: 'ensdomains',
    })
    expect(await fork.ens('get', 'address', name, '--chain-id', '10')).toMatchObject({
      address: owner,
    })
  })

  test('set name sets and clears the primary name', async () => {
    await fork.send(owner, await fork.ens('set', 'name', name))
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name })
    await fork.send(owner, await fork.ens('set', 'name', ''))
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name: null })
  })

  test('renew pays USDC to ETHRegistrar and rejects ETH value', async () => {
    const before = await state(ETH_REGISTRY, label)
    const price = await fork.ens('price', name, '--renew')
    expect(price).toMatchObject({ operation: 'renewal', registrar: v2.registrar, premium: '0' })
    const renew = await fork.ens('renew', name)
    expect(renew).toMatchObject({ to: v2.registrar, value: '0', version: 'v2' })
    await expect(fork.ens('renew', name, '--value', '1')).rejects.toThrow('Do not send ETH value')

    const payer = await fork.account()
    await payFor(payer, v2.registrar, BigInt(price.total))
    await fork.send(payer, renew)
    expect((await state(ETH_REGISTRY, label)).expiry - before.expiry).toBe(YEAR)
  })

  test('resolver set changes the resolver in the v2 registry', async () => {
    const replacement = await fork.account()
    const tx = await fork.ens('resolver', 'set', name, '--resolver', replacement)
    expect(tx).toMatchObject({ to: ETH_REGISTRY, version: 'v2' })
    await fork.send(owner, tx)
    expect(await fork.ens('whois', name)).toMatchObject({ resolver: replacement })
    await fork.send(owner, await fork.ens('resolver', 'set', name, '--resolver', resolver))
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: owner })
  })

  test('subregistry deploy and set, then subname create', async () => {
    const deploy = await fork.ens('subregistry', 'deploy', name, '--deployer', owner)
    expect(deploy).toMatchObject({
      alreadySet: false,
      implementation: v2.subregistryImplementation,
    })
    await fork.send(owner, deploy)
    const set = await fork.ens('subregistry', 'set', name, '--registry', deploy.subregistry)
    expect(set.to).toBe(ETH_REGISTRY)
    await fork.send(owner, set)

    const subOwner = await fork.account()
    const create = await fork.ens('subname', 'create', `sub.${name}`, '--owner', subOwner)
    expect(create).toMatchObject({ to: deploy.subregistry, owner: subOwner })
    await fork.send(owner, create)
    const sub = await state(deploy.subregistry, 'sub')
    expect(sub.status).toBe(2)
    expect(
      await fork.client.readContract({
        address: deploy.subregistry,
        abi: registryAbi,
        functionName: 'ownerOf',
        args: [sub.tokenId],
      }),
    ).toBe(subOwner)

    await expect(fork.ens('subname', 'create', `sub.${name}`, '--owner', subOwner)).rejects.toThrow(
      'already registered',
    )
  })

  test('address records are checksummed on EVM coin types and validated when set', async () => {
    const lower = owner.toLowerCase()
    await fork.send(
      owner,
      await fork.ens('set', 'address', name, '--address', lower, '--coin-type', '61'),
    )
    expect(await fork.ens('get', 'address', name, '--coin-type', '61')).toMatchObject({
      address: owner,
    })

    // 20 bytes on a non-EVM coin type are not an EVM address.
    await fork.send(
      owner,
      await fork.ens('set', 'address', name, '--address', lower, '--coin-type', '2'),
    )
    expect(await fork.ens('get', 'address', name, '--coin-type', '2')).toMatchObject({
      address: lower,
    })

    await expect(
      fork.ens('set', 'address', name, '--address', '0x1234', '--chain-id', '10'),
    ).rejects.toThrow('Invalid EVM address')
  })

  test('register, price and renew reject what the contracts would revert on', async () => {
    const unregistered = `${freshLabel('e2e')}.eth`
    const commit = ['register', 'commit']

    await expect(fork.ens(...commit, name, '--owner', owner)).rejects.toThrow('Cannot register')
    await expect(fork.ens('price', name)).rejects.toThrow('Cannot register')
    await expect(
      fork.ens(...commit, unregistered, '--owner', owner, '--duration', '100'),
    ).rejects.toThrow('Cannot register')
    await expect(fork.ens('price', unregistered, '--paymentToken', USDT)).rejects.toThrow(
      'Cannot register',
    )
    await expect(fork.ens(...commit, unregistered, '--owner', zeroAddress)).rejects.toThrow(
      'zero address',
    )
    await expect(
      fork.ens(
        'register',
        'reveal',
        unregistered,
        '--owner',
        owner,
        '--secret',
        zeroHash,
        '--value',
        '1',
      ),
    ).rejects.toThrow('Do not send ETH value')

    await expect(fork.ens('renew', unregistered)).rejects.toThrow('Cannot renew')
    await expect(fork.ens('price', unregistered, '--renew')).rejects.toThrow('Cannot renew')
    await expect(fork.ens('renew', name, '--payment-token', USDT)).rejects.toThrow('Cannot renew')
  })
})

describe('existing mainnet names', () => {
  // nick.eth was migrated to ENSv2 after the cutover; vitalik.eth is still a reserved v1 name.
  const migrated = 'nick.eth'
  const reserved = 'vitalik.eth'

  beforeAll(async () => {
    expect((await state(ETH_REGISTRY, 'nick')).status).toBe(2)
    expect((await state(ETH_REGISTRY, 'vitalik')).status).toBe(1)
  })

  test('get reads migrated and reserved names', async () => {
    for (const name of [migrated, reserved]) {
      const { address } = await fork.ens('get', 'address', name)
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(await fork.ens('get', 'name', address)).toMatchObject({ name })
      expect((await fork.ens('get', 'text', name, '--key', 'url')).value).toBeTruthy()
      expect((await fork.ens('get', 'avatar', name)).avatar).toBeTruthy()
    }
  })

  test('whois reports ENSv2 state only for the migrated name', async () => {
    expect(await fork.ens('whois', migrated)).toMatchObject({
      registry: ETH_REGISTRY,
      status: 'REGISTERED',
    })
    expect((await fork.ens('whois', reserved)).status).toBeUndefined()
  })

  test('price and renew target ETHRegistrar or ETHRenewerV1 by migration state', async () => {
    for (const [name, registrar] of [
      [migrated, v2.registrar],
      [reserved, v2.renewerV1],
    ] as const) {
      expect(await fork.ens('price', name, '--renew')).toMatchObject({
        registrar,
        paymentToken: v2.paymentToken,
      })
      expect(await fork.ens('renew', name)).toMatchObject({ to: registrar, value: '0' })
    }
  })

  test('set targets the v1 resolver behind the ENSv1 bridge for reserved names', async () => {
    const tx = await fork.ens('set', 'text', reserved, '--key', 'k', '--value', 'v')
    expect(tx.to).toBe((await fork.ens('whois', reserved)).resolver)
    expect(tx.data.slice(0, 10)).toBe('0x10f13a8c') // setText(bytes32,string,string)
  })

  test('set encodes v1 setters for --resolver targets without ERC-165', async () => {
    // An EOA returns no data and the v1 registry reverts on supportsInterface.
    const eoa = await fork.account()
    for (const resolver of [eoa, v1.registry]) {
      const tx = await fork.ens(
        'set',
        'text',
        reserved,
        '--key',
        'k',
        '--value',
        'v',
        '--resolver',
        resolver,
      )
      expect(tx.to.toLowerCase()).toBe(resolver.toLowerCase())
      expect(tx.data.slice(0, 10)).toBe('0x10f13a8c')
    }
  })

  // Migrates the reserved name on the fork, so it must run last.
  test('migrate moves a wrapped locked name through the locked controller', async () => {
    const tokenId = BigInt(labelhash('vitalik'))
    const holder = await fork.client.readContract({
      address: v1.baseRegistrar,
      abi: baseRegistrarAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    })
    // A fresh account can receive the wrapped token whatever code the real holder has.
    const owner = await fork.account()
    await fork.fund(holder)
    await fork.write(holder, v1.baseRegistrar, baseRegistrarAbi, 'transferFrom', [
      holder,
      owner,
      tokenId,
    ])
    await fork.write(owner, v1.baseRegistrar, baseRegistrarAbi, 'approve', [
      v1.nameWrapper,
      tokenId,
    ])
    await fork.write(owner, v1.nameWrapper, nameWrapperAbi, 'wrapETH2LD', [
      'vitalik',
      owner,
      CANNOT_UNWRAP,
      v1.resolver,
    ])

    const migrate = await fork.ens('migrate', reserved)
    expect(migrate).toMatchObject({
      kind: 'wrapped-locked',
      to: v1.nameWrapper,
      controller: v2.lockedMigrationController,
    })
    await fork.send(owner, migrate)
    expect(await fork.ens('whois', reserved)).toMatchObject({ owner, status: 'REGISTERED' })
  })
})
