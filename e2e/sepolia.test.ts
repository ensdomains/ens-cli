import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
} from 'viem'
import { labelhash, namehash, packetToBytes } from 'viem/ens'
import { addresses } from '../src/lib/contracts.ts'
import {
  ROLE_CAN_TRANSFER_ADMIN,
  V2_DEFAULT_OWNER_ROLE_BITMAP as DEFAULT_SUBNAME_ROLES,
} from '../src/lib/v2.ts'
import { freshLabel, startFork, type Fork } from './harness.ts'

setDefaultTimeout(180_000)

const v2 = addresses.sepolia.v2
const usdc = v2.paymentToken
const dai = '0xF6faC8A58a0BE13b9197f27C41B73162Fe32572b'
const ethRegistry = '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4'
const YEAR = 31_536_000

const mintableAbi = [
  ...erc20Abi,
  ...parseAbi(['function mint(address to, uint256 amount) external']),
] as const
const registryAbi = parseAbi([
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function unsafeTransfer(address to, uint256 tokenId, bytes data)',
])
const nameWrapperAbi = parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)',
  'function unwrapETH2LD(bytes32 labelhash, address registrant, address controller)',
  'function setFuses(bytes32 node, uint16 ownerControlledFuses) returns (uint32)',
])
const ensRegistryAbi = parseAbi([
  'function owner(bytes32 node) view returns (address)',
  'function resolver(bytes32 node) view returns (address)',
  'function setResolver(bytes32 node, address resolver)',
])
const baseRegistrarAbi = parseAbi([
  'function nameExpires(uint256 id) view returns (uint256)',
  'function ownerOf(uint256 id) view returns (address)',
])
const contenthashAbi = parseAbi(['function contenthash(bytes32 node) view returns (bytes)'])
const universalResolverAbi = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes result, address resolver)',
])

// ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
const CONTENTHASH = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'

let fork: Fork

beforeAll(async () => {
  fork = await startFork({
    chain: 'sepolia',
    forkUrl: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    forkBlock: process.env.SEPOLIA_FORK_BLOCK,
  })
})

afterAll(() => fork?.stop())

/** Mints the Sepolia test token (open minting) and approves `spender` for exactly `amount`. */
async function payFor(payer: Address, spender: Address, amount: bigint, token: Address = usdc) {
  await fork.write(payer, token, mintableAbi as any, 'mint', [payer, amount])
  await fork.write(payer, token, mintableAbi as any, 'approve', [spender, amount])
}

function state(registry: Address, label: string) {
  return fork.client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: 'getState',
    args: [BigInt(labelhash(label))],
  })
}

function tokenOwner(registry: Address, tokenId: bigint) {
  return fork.client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: 'ownerOf',
    args: [tokenId],
  })
}

/** Reads a contenthash through the Universal Resolver, as clients do. */
async function contenthash(name: string) {
  const [result] = await fork.client.readContract({
    address: addresses.sepolia.universalResolver,
    abi: universalResolverAbi,
    functionName: 'resolve',
    args: [
      toHex(packetToBytes(name)),
      encodeFunctionData({
        abi: contenthashAbi,
        functionName: 'contenthash',
        args: [namehash(name)],
      }),
    ],
  })
  return decodeFunctionResult({ abi: contenthashAbi, functionName: 'contenthash', data: result })
}

describe('ENSv2 name lifecycle', () => {
  let owner: Address
  let resolver: Address
  const label = freshLabel('e2e')
  const name = `${label}.eth`

  beforeAll(async () => {
    owner = await fork.account()
  })

  test('available and price quote a fresh name in USDC', async () => {
    expect(await fork.ens('available', name)).toMatchObject({
      available: true,
      version: 'v2',
      registrar: v2.registrar,
    })

    const price = await fork.ens('price', name)
    expect(price).toMatchObject({
      version: 'v2',
      operation: 'registration',
      paymentToken: usdc,
      tokenSymbol: 'USDC',
      registrar: v2.registrar,
      registry: ethRegistry,
      premium: '0',
    })
    expect(BigInt(price.total)).toBeGreaterThan(0n)
  })

  test('price accepts an alternative payment token', async () => {
    expect(await fork.ens('price', name, '--payment-token', dai)).toMatchObject({
      paymentToken: dai,
      tokenDecimals: 18,
    })
  })

  test('resolver deploy predicts and deploys an OwnedResolver with initial records', async () => {
    const records = JSON.stringify([
      { type: 'address', address: owner, coinType: 60 },
      { type: 'text', key: 'description', value: 'deployed by e2e' },
    ])
    const deploy = await fork.ens('resolver', 'deploy', owner, '--name', name, '--records', records)
    expect(deploy).toMatchObject({ to: v2.resolverFactory, alreadyDeployed: false })
    resolver = deploy.resolver

    await fork.send(owner, deploy)
    expect(await fork.client.getCode({ address: resolver })).not.toBe('0x')
    expect(await fork.ens('resolver', 'deploy', owner)).toMatchObject({
      resolver,
      alreadyDeployed: true,
    })
  })

  test('register commit and reveal pay in USDC and register in the v2 registry', async () => {
    const commit = await fork.ens('register', 'commit', name, '--owner', owner)
    // The owner's deployed OwnedResolver is picked up without --resolver.
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
      '--resolver',
      resolver,
    )
    expect(reveal.value).toBe('0')
    await fork.send(owner, reveal)

    expect(await fork.ens('whois', name)).toMatchObject({
      owner,
      resolver,
      registry: ethRegistry,
      status: 'REGISTERED',
    })
    expect(await fork.ens('available', name)).toMatchObject({ available: false })
  })

  test('records initialized at deployment resolve through the Universal Resolver', async () => {
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: owner })
    expect(await fork.ens('get', 'text', name, '--key', 'description')).toMatchObject({
      value: 'deployed by e2e',
    })
  })

  test('set address, text, contenthash and batch use the PermissionedResolver setters', async () => {
    const other = await fork.account()
    await fork.send(owner, await fork.ens('set', 'address', name, '--address', other))
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: other })

    await fork.send(
      owner,
      await fork.ens('set', 'text', name, '--key', 'url', '--value', 'https://ens.domains'),
    )
    expect(await fork.ens('get', 'text', name, '--key', 'url')).toMatchObject({
      value: 'https://ens.domains',
    })

    await fork.send(owner, await fork.ens('set', 'contenthash', name, '--hash', CONTENTHASH))
    expect(await contenthash(name)).toBe(CONTENTHASH)

    const btc = '0x76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'
    const batch = JSON.stringify([
      { type: 'address', address: owner, coinType: 60 },
      { type: 'address', address: btc, coinType: 0 },
      { type: 'text', key: 'com.github', value: 'ensdomains' },
      { type: 'text', key: 'avatar', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
    ])
    await fork.send(owner, await fork.ens('set', 'batch', name, '--data', batch))
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: owner })
    expect(await fork.ens('get', 'address', name, '--coin-type', '0')).toMatchObject({
      address: btc,
    })
    expect(await fork.ens('get', 'text', name, '--key', 'com.github')).toMatchObject({
      value: 'ensdomains',
    })
    expect(await fork.ens('get', 'avatar', name)).toMatchObject({
      avatar: 'data:image/svg+xml;base64,PHN2Zy8+',
    })
  })

  test('set address with empty bytes clears the ETH record', async () => {
    await fork.send(owner, await fork.ens('set', 'address', name, '--address', '0x'))
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: null })
    await fork.send(owner, await fork.ens('set', 'address', name, '--address', owner))
  })

  test('set name sets a primary name that reverse resolves, and clears it', async () => {
    await fork.send(owner, await fork.ens('set', 'name', name))
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name })

    await fork.send(owner, await fork.ens('set', 'name', ''))
    expect(await fork.ens('get', 'name', owner)).toMatchObject({ name: null })
  })

  test('renew goes through ETHRegistrar and extends the v2 expiry', async () => {
    const before = await state(ethRegistry, label)
    const price = await fork.ens('price', name, '--renew')
    expect(price).toMatchObject({ operation: 'renewal', registrar: v2.registrar, premium: '0' })

    const renew = await fork.ens('renew', name)
    expect(renew).toMatchObject({ to: v2.registrar, value: '0', version: 'v2' })
    // Anyone can pay for a renewal.
    const payer = await fork.account()
    await payFor(payer, v2.registrar, BigInt(price.total))
    await fork.send(payer, renew)

    const after = await state(ethRegistry, label)
    expect(after.expiry - before.expiry).toBe(BigInt(YEAR))
  })

  test('renew rejects ETH value for v2 names', async () => {
    await expect(fork.ens('renew', name, '--value', '1')).rejects.toThrow('Do not send ETH value')
  })

  test('resolver set changes the resolver in the v2 registry', async () => {
    const replacement = await fork.account()
    await fork.send(owner, await fork.ens('resolver', 'set', name, '--resolver', replacement))
    expect(await fork.ens('whois', name)).toMatchObject({ resolver: replacement })

    await fork.send(owner, await fork.ens('resolver', 'set', name, '--resolver', resolver))
    expect(await fork.ens('whois', name)).toMatchObject({ resolver })
    expect(await fork.ens('get', 'address', name)).toMatchObject({ address: owner })
  })

  describe('subregistry and subnames', () => {
    let subregistry: Address
    let subOwner: Address
    const sub = `sub.${name}`

    test('subregistry deploy and set attach a UserRegistry', async () => {
      const deploy = await fork.ens('subregistry', 'deploy', name, '--deployer', owner)
      expect(deploy).toMatchObject({
        alreadyDeployed: false,
        alreadySet: false,
        rootAccount: owner,
      })
      subregistry = deploy.subregistry
      await fork.send(owner, deploy)
      expect(await fork.client.getCode({ address: subregistry })).not.toBe('0x')

      const set = await fork.ens('subregistry', 'set', name, '--registry', subregistry)
      expect(set.to).toBe(ethRegistry)
      await fork.send(owner, set)

      expect(await fork.ens('subregistry', 'deploy', name, '--deployer', owner)).toMatchObject({
        alreadySet: true,
        subregistry,
      })
    })

    test('subname create registers in the parent subregistry', async () => {
      subOwner = await fork.account()
      const create = await fork.ens(
        'subname',
        'create',
        sub,
        '--owner',
        subOwner,
        '--resolver',
        resolver,
      )
      expect(create).toMatchObject({
        to: subregistry,
        parentRegistry: subregistry,
        owner: subOwner,
      })
      await fork.send(owner, create)

      const subState = await state(subregistry, 'sub')
      expect(subState.status).toBe(2)
      expect(await tokenOwner(subregistry, subState.tokenId)).toBe(subOwner)
    })

    test('subnames created with the default roles can be transferred', async () => {
      // A UserRegistry whose root account keeps admin roles is not emancipated, so the
      // contracts only allow unsafeTransfer, which still requires ROLE_CAN_TRANSFER_ADMIN.
      const recipient = await fork.account()
      const { tokenId } = await state(subregistry, 'sub')
      await fork.write(subOwner, subregistry, registryAbi, 'unsafeTransfer', [
        recipient,
        tokenId,
        '0x',
      ])
      expect(await tokenOwner(subregistry, (await state(subregistry, 'sub')).tokenId)).toBe(
        recipient,
      )
      subOwner = recipient
    })

    test('subnames created without ROLE_CAN_TRANSFER_ADMIN cannot be transferred', async () => {
      const holder = await fork.account()
      const roles = (DEFAULT_SUBNAME_ROLES & ~ROLE_CAN_TRANSFER_ADMIN).toString()
      await fork.send(
        owner,
        await fork.ens(
          'subname',
          'create',
          `locked.${name}`,
          '--owner',
          holder,
          '--role-bitmap',
          roles,
        ),
      )
      const { tokenId } = await state(subregistry, 'locked')
      const recipient = await fork.account()
      await expect(
        fork.write(holder, subregistry, registryAbi, 'unsafeTransfer', [recipient, tokenId, '0x']),
      ).rejects.toThrow()
    })

    test('subregistry set targets the parent subregistry for subnames', async () => {
      const nested = await fork.account()
      const set = await fork.ens('subregistry', 'set', sub, '--registry', nested)
      expect(set).toMatchObject({ to: subregistry, parentRegistry: subregistry })
      await fork.send(subOwner, set)
    })

    test('resolver set and whois reject ENSv2 subnames', async () => {
      await expect(fork.ens('resolver', 'set', sub, '--resolver', resolver)).rejects.toThrow(
        'only supports 2LD .eth names',
      )
      await expect(fork.ens('whois', sub)).rejects.toThrow('only supports 2LD .eth names')
    })
  })
})

const CANNOT_UNWRAP = 1
const GRACE_PERIOD = 90n * 86_400n
// Well-known Sepolia names; the suite picks whichever are still reserved v1 names.
const CANDIDATE_LABELS = [
  'test',
  'ens',
  'nick',
  'vitalik',
  'gregskril',
  'hello',
  'alice',
  'bob',
  'foo',
  'bar',
  'wallet',
  'crypto',
  'web3',
  'dao',
  'demo',
  'app',
  'dev',
  'name',
  'abc',
  'xyz',
]

type ReservedName = { label: string; name: string; owner: Address; v1Expiry: bigint }

/** Unmigrated, unexpired, wrapped-unlocked .eth names owned by an EOA. */
async function findReservedNames(count: number): Promise<ReservedName[]> {
  const now = await fork.now()
  const found: ReservedName[] = []
  for (const label of CANDIDATE_LABELS) {
    const name = `${label}.eth`
    const [{ status }, [owner, fuses], v1Expiry] = await Promise.all([
      state(ethRegistry, label),
      fork.client.readContract({
        address: addresses.sepolia.nameWrapper,
        abi: nameWrapperAbi,
        functionName: 'getData',
        args: [BigInt(namehash(name))],
      }),
      fork.client.readContract({
        address: addresses.sepolia.baseRegistrar,
        abi: baseRegistrarAbi,
        functionName: 'nameExpires',
        args: [BigInt(labelhash(label))],
      }),
    ])
    if (status !== 1 || v1Expiry <= now || (fuses & CANNOT_UNWRAP) !== 0) continue
    if ((await fork.client.getCode({ address: owner })) !== undefined) continue
    await fork.fund(owner)
    found.push({ label, name, owner, v1Expiry })
    if (found.length === count) return found
  }
  throw new Error(`found only ${found.length} reserved Sepolia names; add more candidates`)
}

function registryResolver(name: string) {
  return fork.client.readContract({
    address: addresses.sepolia.registry,
    abi: ensRegistryAbi,
    functionName: 'resolver',
    args: [namehash(name)],
  })
}

describe('ENSv1 names reserved in ENSv2', () => {
  let wrapped: ReservedName
  let unwrapped: ReservedName
  let unlocked: ReservedName
  let locked: ReservedName

  beforeAll(async () => {
    ;[wrapped, unwrapped, unlocked, locked] = (await findReservedNames(4)) as [
      ReservedName,
      ReservedName,
      ReservedName,
      ReservedName,
    ]

    // Convert two of the wrapped names so every migration path is covered.
    await fork.write(
      unwrapped.owner,
      addresses.sepolia.nameWrapper,
      nameWrapperAbi,
      'unwrapETH2LD',
      [labelhash(unwrapped.label), unwrapped.owner, unwrapped.owner],
    )
    await fork.write(locked.owner, addresses.sepolia.nameWrapper, nameWrapperAbi, 'setFuses', [
      namehash(locked.name),
      CANNOT_UNWRAP,
    ])
  })

  test('available, whois and price treat reserved names as v1 names', async () => {
    expect(await fork.ens('available', wrapped.name)).toMatchObject({ available: false })
    expect(await fork.ens('whois', wrapped.name)).toMatchObject({
      owner: addresses.sepolia.nameWrapper,
    })
    expect(await fork.ens('whois', unwrapped.name)).toMatchObject({ owner: unwrapped.owner })
    expect(await fork.ens('price', wrapped.name, '--renew')).toMatchObject({
      operation: 'renewal',
      registrar: v2.renewerV1,
      paymentToken: usdc,
    })
  })

  test('renew goes through ETHRenewerV1 and extends the v1 expiry', async () => {
    const price = await fork.ens('price', wrapped.name, '--renew')
    const renew = await fork.ens('renew', wrapped.name)
    expect(renew).toMatchObject({ to: v2.renewerV1, value: '0', version: 'v2' })

    const payer = await fork.account()
    await payFor(payer, v2.renewerV1, BigInt(price.total))
    await fork.send(payer, renew)

    const v1Expiry = await fork.client.readContract({
      address: addresses.sepolia.baseRegistrar,
      abi: baseRegistrarAbi,
      functionName: 'nameExpires',
      args: [BigInt(labelhash(wrapped.label))],
    })
    expect(v1Expiry - wrapped.v1Expiry).toBe(BigInt(YEAR))
    expect((await state(ethRegistry, wrapped.label)).status).toBe(1)
  })

  test('set and get records on a v1 resolver use namehash setters', async () => {
    const resolver = await registryResolver(wrapped.name)
    const records = await fork.ens(
      'set',
      'text',
      wrapped.name,
      '--key',
      'e2e',
      '--value',
      'v1 resolver',
    )
    expect(records.to).toBe(resolver)
    await fork.send(wrapped.owner, records)
    expect(await fork.ens('get', 'text', wrapped.name, '--key', 'e2e')).toMatchObject({
      value: 'v1 resolver',
    })

    const target = await fork.account()
    await fork.send(
      wrapped.owner,
      await fork.ens('set', 'address', wrapped.name, '--address', target),
    )
    expect(await fork.ens('get', 'address', wrapped.name)).toMatchObject({ address: target })
  })

  test('resolver set routes wrapped names to the NameWrapper and unwrapped names to the registry', async () => {
    const wrappedTx = await fork.ens(
      'resolver',
      'set',
      wrapped.name,
      '--resolver',
      addresses.sepolia.resolver,
    )
    expect(wrappedTx.to).toBe(addresses.sepolia.nameWrapper)
    await fork.send(wrapped.owner, wrappedTx)
    expect(await registryResolver(wrapped.name)).toBe(addresses.sepolia.resolver)

    const unwrappedTx = await fork.ens(
      'resolver',
      'set',
      unwrapped.name,
      '--resolver',
      addresses.sepolia.resolver,
    )
    expect(unwrappedTx.to).toBe(addresses.sepolia.registry)
    await fork.send(unwrapped.owner, unwrappedTx)
    expect(await registryResolver(unwrapped.name)).toBe(addresses.sepolia.resolver)
  })

  test('set rejects v1 names whose bridge finds no resolver', async () => {
    // ENSV1Resolver walks up to ancestor resolvers, so clear the name's and .eth's.
    const snapshot = await fork.client.snapshot()
    try {
      const ethOwner = await fork.client.readContract({
        address: addresses.sepolia.registry,
        abi: ensRegistryAbi,
        functionName: 'owner',
        args: [namehash('eth')],
      })
      await fork.fund(ethOwner)
      for (const [from, node] of [
        [unwrapped.owner, namehash(unwrapped.name)],
        [ethOwner, namehash('eth')],
      ] as const) {
        await fork.write(from, addresses.sepolia.registry, ensRegistryAbi, 'setResolver', [
          node,
          zeroAddress,
        ])
      }
      await expect(
        fork.ens('set', 'text', unwrapped.name, '--key', 'k', '--value', 'v'),
      ).rejects.toThrow('No resolver set')
    } finally {
      await fork.client.revert({ id: snapshot })
    }
  })

  test('set aborts on RPC errors instead of guessing the resolver', async () => {
    const setText = ['set', 'text', wrapped.name, '--key', 'k', '--value', 'v']
    // Probes whose failure would otherwise target the bridge or pick the wrong setters.
    const getResolver = toFunctionSelector('getResolver(bytes)')
    const v2Setters = `0x01ffc9a7${toFunctionSelector('setAddress(bytes,uint256,bytes)').slice(2)}`
    const via = async (probe: string, error: object | undefined, run: (url: string) => unknown) => {
      const proxy = fork.faultyRpc((body) => body.includes(`"data":"${probe}`), error)
      try {
        await run(proxy.url)
      } finally {
        proxy.stop()
      }
    }

    const message = 'Internal error: upstream temporarily unavailable'
    for (const probe of [getResolver, v2Setters]) {
      for (const error of [
        { code: -32603, message },
        { code: -32603, message, data: { requestId: 'rpc-123' } },
      ]) {
        await via(probe, error, (url) =>
          expect(fork.ensVia(url, ...setText)).rejects.toThrow('upstream temporarily unavailable'),
        )
      }
    }

    // Nodes that report a genuine revert as -32603 still fall back to the v1 setters.
    await via(v2Setters, { code: -32603, message: 'execution reverted' }, async (url) => {
      expect((await fork.ensVia(url, ...setText)).data.slice(0, 10)).toBe('0x10f13a8c')
    })
    expect((await fork.ens(...setText)).to).toBe(await registryResolver(wrapped.name))
  })

  test('subname create routes wrapped parents to the NameWrapper and unwrapped parents to the registry', async () => {
    const subOwner = await fork.account()

    const wrappedSub = `e2e.${wrapped.name}`
    const wrappedTx = await fork.ens('subname', 'create', wrappedSub, '--owner', subOwner)
    expect(wrappedTx).toMatchObject({ to: addresses.sepolia.nameWrapper, wrapped: true })
    await fork.send(wrapped.owner, wrappedTx)
    expect(
      await fork.client.readContract({
        address: addresses.sepolia.nameWrapper,
        abi: nameWrapperAbi,
        functionName: 'ownerOf',
        args: [BigInt(namehash(wrappedSub))],
      }),
    ).toBe(subOwner)

    const unwrappedSub = `e2e.${unwrapped.name}`
    const unwrappedTx = await fork.ens('subname', 'create', unwrappedSub, '--owner', subOwner)
    expect(unwrappedTx).toMatchObject({ to: addresses.sepolia.registry, wrapped: false })
    await fork.send(unwrapped.owner, unwrappedTx)
    expect(await fork.ens('whois', unwrappedSub)).toMatchObject({ owner: subOwner })
  })

  test('migrate moves an unwrapped name into ENSv2', async () => {
    const migrate = await fork.ens('migrate', unwrapped.name)
    expect(migrate).toMatchObject({
      kind: 'unwrapped',
      to: addresses.sepolia.baseRegistrar,
      controller: v2.unlockedMigrationController,
      owner: unwrapped.owner,
    })
    await fork.send(unwrapped.owner, migrate)
    expect(await fork.ens('whois', unwrapped.name)).toMatchObject({
      owner: unwrapped.owner,
      status: 'REGISTERED',
    })
  })

  test('migrate moves a wrapped unlocked name into ENSv2 with the owner resolver', async () => {
    const deploy = await fork.ens(
      'resolver',
      'deploy',
      unlocked.owner,
      '--name',
      unlocked.name,
      '--records',
      JSON.stringify([{ type: 'text', key: 'e2e', value: 'migrated' }]),
    )
    await fork.send(unlocked.owner, deploy)

    const migrate = await fork.ens('migrate', unlocked.name)
    expect(migrate).toMatchObject({
      kind: 'wrapped-unlocked',
      to: addresses.sepolia.nameWrapper,
      controller: v2.unlockedMigrationController,
      resolver: deploy.resolver,
    })
    await fork.send(unlocked.owner, migrate)
    expect(await fork.ens('whois', unlocked.name)).toMatchObject({
      owner: unlocked.owner,
      resolver: deploy.resolver,
      status: 'REGISTERED',
    })
    expect(await fork.ens('get', 'text', unlocked.name, '--key', 'e2e')).toMatchObject({
      value: 'migrated',
    })

    // After migration, records go through the v2 setters and renewals through ETHRegistrar.
    await fork.send(
      unlocked.owner,
      await fork.ens('set', 'text', unlocked.name, '--key', 'e2e', '--value', 'updated'),
    )
    expect(await fork.ens('get', 'text', unlocked.name, '--key', 'e2e')).toMatchObject({
      value: 'updated',
    })
    expect(await fork.ens('renew', unlocked.name)).toMatchObject({ to: v2.registrar })
  })

  test('migrate moves a wrapped locked name into ENSv2', async () => {
    const migrate = await fork.ens('migrate', locked.name)
    expect(migrate).toMatchObject({
      kind: 'wrapped-locked',
      to: addresses.sepolia.nameWrapper,
      controller: v2.lockedMigrationController,
    })
    await fork.send(locked.owner, migrate)
    expect(await fork.ens('whois', locked.name)).toMatchObject({
      owner: locked.owner,
      status: 'REGISTERED',
    })
  })

  test('migrate rejects names that are already in ENSv2', async () => {
    await expect(fork.ens('migrate', unwrapped.name)).rejects.toThrow('already registered in ENSv2')
  })

  // Moves the fork's clock forward, so it must run last.
  test('expired names in grace are renewed through ETHRenewerV1 before they can migrate', async () => {
    const v1Expiry = await fork.client.readContract({
      address: addresses.sepolia.baseRegistrar,
      abi: baseRegistrarAbi,
      functionName: 'nameExpires',
      args: [BigInt(labelhash(wrapped.label))],
    })
    await fork.advance(Number(v1Expiry - (await fork.now()) + 86_400n))
    expect(await fork.now()).toBeLessThan(v1Expiry + GRACE_PERIOD)

    await expect(fork.ens('migrate', wrapped.name)).rejects.toThrow('v1 grace period')

    const price = await fork.ens('price', wrapped.name, '--renew')
    expect(price.registrar).toBe(v2.renewerV1)
    const renew = await fork.ens('renew', wrapped.name)
    expect(renew.to).toBe(v2.renewerV1)
    await payFor(wrapped.owner, v2.renewerV1, BigInt(price.total))
    await fork.send(wrapped.owner, renew)

    const migrate = await fork.ens('migrate', wrapped.name)
    expect(migrate.kind).toBe('wrapped-unlocked')
    await fork.send(wrapped.owner, migrate)
    expect(await fork.ens('whois', wrapped.name)).toMatchObject({ status: 'REGISTERED' })
  })
})
