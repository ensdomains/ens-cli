import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { erc20Abi, parseAbi, type Address } from 'viem'
import { labelhash, namehash } from 'viem/ens'
import { addresses } from '../src/lib/contracts.ts'
import { freshLabel, startFork, type Fork } from './harness.ts'

setDefaultTimeout(180_000)

// Walks every CLI feature on a live fork as the real holders of gregskril.eth, an
// unmigrated ENSv1 name: unwrapped on mainnet, wrapped and unlocked on Sepolia.
const LABEL = 'gregskril'
const NAME = `${LABEL}.eth`
// The name's address record, primary name and ENSv1 registry owner (or wrapped owner).
const MANAGER: Address = '0x179A862703a4adfb29896552DF9e307980D19285'
const YEAR = 31_536_000n
const CONTENTHASH = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
const AVATAR = 'https://gregskril.com/img/profile.jpg'

const forkUrls = {
  mainnet: process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
  sepolia: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
}

const baseRegistrarAbi = parseAbi([
  'function nameExpires(uint256 id) view returns (uint256)',
  'function ownerOf(uint256 id) view returns (address)',
])
const nameWrapperAbi = parseAbi(['function ownerOf(uint256 id) view returns (address)'])
const ensRegistryAbi = parseAbi(['function resolver(bytes32 node) view returns (address)'])
const registryAbi = parseAbi([
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function ownerOf(uint256 tokenId) view returns (address)',
])

for (const chain of ['mainnet', 'sepolia'] as const) {
  const v1 = addresses[chain]
  const v2 = addresses[chain].v2
  const wrapped = chain === 'sepolia'

  describe(`${NAME} on ${chain}`, () => {
    let fork: Fork
    let ethRegistry: Address
    let v1Resolver: Address
    // The ENSv1 token holder, who sends the migration.
    let registrant: Address
    // A fresh ENSv2 owner: it has no OwnedResolver, whatever the holder has deployed on the live chain.
    let v2Owner: Address
    let ownedResolver: Address

    beforeAll(async () => {
      fork = await startFork({ chain, forkUrl: forkUrls[chain] })
      v1Resolver = await registryResolver(NAME)
      registrant = wrapped
        ? await fork.client.readContract({
            address: v1.nameWrapper,
            abi: nameWrapperAbi,
            functionName: 'ownerOf',
            args: [BigInt(namehash(NAME))],
          })
        : await fork.client.readContract({
            address: v1.baseRegistrar,
            abi: baseRegistrarAbi,
            functionName: 'ownerOf',
            args: [BigInt(labelhash(LABEL))],
          })
      await fork.fund(MANAGER)
      await fork.fund(registrant)
      v2Owner = await fork.account()
    })

    afterAll(() => fork?.stop())

    function registryResolver(name: string) {
      return fork.client.readContract({
        address: v1.registry,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [namehash(name)],
      })
    }

    function v1Expiry() {
      return fork.client.readContract({
        address: v1.baseRegistrar,
        abi: baseRegistrarAbi,
        functionName: 'nameExpires',
        args: [BigInt(labelhash(LABEL))],
      })
    }

    function state(registry: Address, label: string) {
      return fork.client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: 'getState',
        args: [BigInt(labelhash(label))],
      })
    }

    /** Gives `payer` exactly `amount` of the payment token and approves `spender` for it. */
    async function payFor(payer: Address, spender: Address, amount: bigint) {
      await fork.client.request({
        method: 'anvil_dealERC20' as any,
        params: [payer, v2.paymentToken, `0x${amount.toString(16)}`] as any,
      })
      await fork.write(payer, v2.paymentToken, erc20Abi, 'approve', [spender, amount])
    }

    describe('as a reserved ENSv1 name', () => {
      test('ENSv2 is detected and the name reads as a reserved v1 name', async () => {
        const available = await fork.ens('available', NAME)
        expect(available).toMatchObject({
          available: false,
          version: 'v2',
          registrar: v2.registrar,
        })
        ethRegistry = available.registry
        // Fails once the name is migrated for real; this suite needs a reserved name.
        expect((await state(ethRegistry, LABEL)).status).toBe(1)

        expect(await fork.ens('whois', NAME)).toMatchObject({
          owner: wrapped ? v1.nameWrapper : MANAGER,
          resolver: v1Resolver,
        })
      })

      test('get reads address, primary name, text and avatar', async () => {
        expect(await fork.ens('get', 'address', NAME)).toMatchObject({ address: MANAGER })
        expect(await fork.ens('get', 'name', MANAGER)).toMatchObject({ name: NAME })
        expect(await fork.ens('get', 'text', NAME, '--key', 'avatar')).toMatchObject({
          value: AVATAR,
        })
        expect(await fork.ens('get', 'avatar', NAME)).toMatchObject({ avatar: AVATAR })
      })

      test('price and renew go through ETHRenewerV1 in USDC', async () => {
        const before = await v1Expiry()
        const price = await fork.ens('price', NAME, '--renew')
        expect(price).toMatchObject({
          operation: 'renewal',
          registrar: v2.renewerV1,
          paymentToken: v2.paymentToken,
          tokenSymbol: 'USDC',
          premium: '0',
        })
        const renew = await fork.ens('renew', NAME)
        expect(renew).toMatchObject({ to: v2.renewerV1, value: '0', version: 'v2' })
        await expect(fork.ens('renew', NAME, '--value', '1')).rejects.toThrow(
          'Do not send ETH value',
        )

        // Anyone can pay for a renewal.
        const payer = await fork.account()
        await payFor(payer, v2.renewerV1, BigInt(price.total))
        await fork.send(payer, renew)
        expect((await v1Expiry()) - before).toBe(YEAR)
        expect((await state(ethRegistry, LABEL)).status).toBe(1)
      })

      test('set writes records with the v1 resolver setters', async () => {
        const text = await fork.ens('set', 'text', NAME, '--key', 'e2e', '--value', 'v1')
        expect(text).toMatchObject({ to: v1Resolver })
        expect(text.data.slice(0, 10)).toBe('0x10f13a8c') // setText(bytes32,string,string)
        expect(text.warning).toBeUndefined()
        await fork.send(MANAGER, text)
        expect(await fork.ens('get', 'text', NAME, '--key', 'e2e')).toMatchObject({ value: 'v1' })

        await fork.send(MANAGER, await fork.ens('set', 'contenthash', NAME, '--hash', CONTENTHASH))
        const batch = JSON.stringify([
          { type: 'text', key: 'com.github', value: 'gskril' },
          { type: 'address', address: MANAGER, chainId: 10 },
        ])
        await fork.send(MANAGER, await fork.ens('set', 'batch', NAME, '--data', batch))
        expect(await fork.ens('get', 'text', NAME, '--key', 'com.github')).toMatchObject({
          value: 'gskril',
        })
        expect(await fork.ens('get', 'address', NAME, '--chain-id', '10')).toMatchObject({
          address: MANAGER,
        })

        await fork.send(MANAGER, await fork.ens('set', 'address', NAME, '--address', MANAGER))
        expect(await fork.ens('get', 'address', NAME)).toMatchObject({ address: MANAGER })
      })

      test('set name clears and re-sets the primary name', async () => {
        await fork.send(MANAGER, await fork.ens('set', 'name', ''))
        expect(await fork.ens('get', 'name', MANAGER)).toMatchObject({ name: null })
        await fork.send(MANAGER, await fork.ens('set', 'name', NAME))
        expect(await fork.ens('get', 'name', MANAGER)).toMatchObject({ name: NAME })
      })

      test('resolver set and subname create route through the v1 contracts', async () => {
        const target = wrapped ? v1.nameWrapper : v1.registry
        const other = await fork.account()
        const tx = await fork.ens('resolver', 'set', NAME, '--resolver', other)
        expect(tx).toMatchObject({ to: target, version: 'v1', wrapped })
        await fork.send(MANAGER, tx)
        expect(await registryResolver(NAME)).toBe(other)
        await fork.send(MANAGER, await fork.ens('resolver', 'set', NAME, '--resolver', v1Resolver))
        expect(await fork.ens('get', 'address', NAME)).toMatchObject({ address: MANAGER })

        const sub = `v1sub.${NAME}`
        const create = await fork.ens('subname', 'create', sub, '--owner', other)
        expect(create).toMatchObject({ to: target, wrapped, resolver: v1.resolver })
        await fork.send(MANAGER, create)
        expect(await registryResolver(sub)).toBe(v1.resolver)
      })

      test('subregistry set rejects a name that is not in ENSv2 yet', async () => {
        await expect(fork.ens('subregistry', 'set', NAME, '--registry', MANAGER)).rejects.toThrow(
          'not registered in its ENSv2 parent registry',
        )
      })
    })

    describe('migrating to ENSv2 with the default resolver', () => {
      test('migrate warns that the reused v1 resolver becomes read-only', async () => {
        expect(await fork.ens('migrate', NAME)).toMatchObject({
          currentOwner: registrant,
          owner: registrant,
        })

        const migrate = await fork.ens('migrate', NAME, '--owner', v2Owner)
        expect(migrate).toMatchObject({
          kind: wrapped ? 'wrapped-unlocked' : 'unwrapped',
          to: wrapped ? v1.nameWrapper : v1.baseRegistrar,
          controller: v2.unlockedMigrationController,
          currentOwner: registrant,
          owner: v2Owner,
          resolver: v1Resolver,
        })
        expect(migrate.flags[0]).toStartWith('Warning: no canonical OwnedResolver')

        const expiry = await v1Expiry()
        await fork.send(registrant, migrate)

        const whois = await fork.ens('whois', NAME)
        expect(whois).toMatchObject({
          owner: v2Owner,
          resolver: v1Resolver,
          registry: ethRegistry,
          status: 'REGISTERED',
        })
        expect(BigInt(whois.expiry)).toBeGreaterThanOrEqual(expiry)
        await expect(fork.ens('migrate', NAME)).rejects.toThrow('already registered in ENSv2')
      })

      test('resolution and the primary name survive migration', async () => {
        expect(await fork.ens('get', 'address', NAME)).toMatchObject({ address: MANAGER })
        expect(await fork.ens('get', 'text', NAME, '--key', 'e2e')).toMatchObject({ value: 'v1' })
        expect(await fork.ens('get', 'avatar', NAME)).toMatchObject({ avatar: AVATAR })
        expect(await fork.ens('get', 'name', MANAGER)).toMatchObject({ name: NAME })
      })

      test('records on the reused v1 resolver can no longer be changed', async () => {
        const text = await fork.ens('set', 'text', NAME, '--key', 'e2e', '--value', 'changed')
        expect(text.to).toBe(v1Resolver)
        expect(text.warning).toContain('is registered in ENSv2, but')
        for (const from of [v2Owner, registrant, MANAGER]) {
          await expect(fork.send(from, text)).rejects.toThrow()
        }
      })

      test('resolver deploy and resolver set restore editable records', async () => {
        const deploy = await fork.ens(
          'resolver',
          'deploy',
          v2Owner,
          '--name',
          NAME,
          '--records',
          JSON.stringify([
            { type: 'address', address: MANAGER, coinType: 60 },
            { type: 'text', key: 'avatar', value: AVATAR },
          ]),
        )
        expect(deploy).toMatchObject({ to: v2.resolverFactory, alreadyDeployed: false })
        ownedResolver = deploy.resolver
        await fork.send(v2Owner, deploy)
        expect(await fork.ens('resolver', 'deploy', v2Owner)).toMatchObject({
          resolver: ownedResolver,
          alreadyDeployed: true,
        })

        const set = await fork.ens('resolver', 'set', NAME, '--resolver', ownedResolver)
        expect(set).toMatchObject({ to: ethRegistry, version: 'v2' })
        await fork.send(v2Owner, set)
        expect(await fork.ens('whois', NAME)).toMatchObject({ resolver: ownedResolver })
        expect(await fork.ens('get', 'address', NAME)).toMatchObject({ address: MANAGER })
        expect(await fork.ens('get', 'avatar', NAME)).toMatchObject({ avatar: AVATAR })
        expect(await fork.ens('get', 'name', MANAGER)).toMatchObject({ name: NAME })
      })
    })

    describe('as a migrated ENSv2 name', () => {
      test('set uses the PermissionedResolver setters', async () => {
        const text = await fork.ens(
          'set',
          'text',
          NAME,
          '--key',
          'url',
          '--value',
          'https://gregskril.com',
        )
        expect(text.to).toBe(ownedResolver)
        expect(text.warning).toBeUndefined()
        await fork.send(v2Owner, text)
        expect(await fork.ens('get', 'text', NAME, '--key', 'url')).toMatchObject({
          value: 'https://gregskril.com',
        })

        await fork.send(v2Owner, await fork.ens('set', 'contenthash', NAME, '--hash', CONTENTHASH))
        const other = await fork.account()
        const batch = JSON.stringify([
          { type: 'address', address: other, coinType: 60 },
          { type: 'text', key: 'com.github', value: 'gskril' },
        ])
        await fork.send(v2Owner, await fork.ens('set', 'batch', NAME, '--data', batch))
        expect(await fork.ens('get', 'address', NAME)).toMatchObject({ address: other })
        expect(await fork.ens('get', 'text', NAME, '--key', 'com.github')).toMatchObject({
          value: 'gskril',
        })

        await fork.send(v2Owner, await fork.ens('set', 'address', NAME, '--address', MANAGER))
        expect(await fork.ens('get', 'address', NAME)).toMatchObject({ address: MANAGER })
      })

      test('set name clears and re-sets the primary name', async () => {
        await fork.send(MANAGER, await fork.ens('set', 'name', ''))
        expect(await fork.ens('get', 'name', MANAGER)).toMatchObject({ name: null })
        await fork.send(MANAGER, await fork.ens('set', 'name', NAME))
        expect(await fork.ens('get', 'name', MANAGER)).toMatchObject({ name: NAME })
      })

      test('price and renew go through ETHRegistrar', async () => {
        const before = await state(ethRegistry, LABEL)
        const price = await fork.ens('price', NAME, '--renew')
        expect(price).toMatchObject({ registrar: v2.registrar, premium: '0' })
        const renew = await fork.ens('renew', NAME)
        expect(renew).toMatchObject({ to: v2.registrar, value: '0' })
        await payFor(v2Owner, v2.registrar, BigInt(price.total))
        await fork.send(v2Owner, renew)
        expect((await state(ethRegistry, LABEL)).expiry - before.expiry).toBe(YEAR)
      })

      test('subregistry deploy and set, then subname create', async () => {
        const deploy = await fork.ens('subregistry', 'deploy', NAME, '--deployer', v2Owner)
        expect(deploy).toMatchObject({ alreadySet: false, rootAccount: v2Owner })
        await fork.send(v2Owner, deploy)
        const set = await fork.ens('subregistry', 'set', NAME, '--registry', deploy.subregistry)
        expect(set.to).toBe(ethRegistry)
        await fork.send(v2Owner, set)
        expect(await fork.ens('subregistry', 'deploy', NAME, '--deployer', v2Owner)).toMatchObject({
          alreadySet: true,
          subregistry: deploy.subregistry,
        })

        const subOwner = await fork.account()
        const create = await fork.ens(
          'subname',
          'create',
          `cli.${NAME}`,
          '--owner',
          subOwner,
          '--resolver',
          ownedResolver,
        )
        expect(create).toMatchObject({ to: deploy.subregistry, owner: subOwner })
        await fork.send(v2Owner, create)
        const sub = await state(deploy.subregistry, 'cli')
        expect(sub.status).toBe(2)
        expect(
          await fork.client.readContract({
            address: deploy.subregistry,
            abi: registryAbi,
            functionName: 'ownerOf',
            args: [sub.tokenId],
          }),
        ).toBe(subOwner)
      })

      test('register commit and reveal a fresh name with the owned resolver', async () => {
        const name = `${freshLabel('gsk')}.eth`
        expect(await fork.ens('available', name)).toMatchObject({ available: true, version: 'v2' })
        const commit = await fork.ens('register', 'commit', name, '--owner', v2Owner)
        expect(commit).toMatchObject({
          to: v2.registrar,
          resolver: ownedResolver,
          resolverSource: 'ownedResolver',
        })
        await fork.send(v2Owner, commit)
        await fork.advance(70)

        const price = await fork.ens('price', name)
        expect(price).toMatchObject({ operation: 'registration', paymentToken: v2.paymentToken })
        await payFor(v2Owner, v2.registrar, BigInt(price.total))
        const reveal = await fork.ens(
          'register',
          'reveal',
          name,
          '--owner',
          v2Owner,
          '--secret',
          commit.secret,
        )
        expect(reveal.value).toBe('0')
        await fork.send(v2Owner, reveal)
        expect(await fork.ens('whois', name)).toMatchObject({
          owner: v2Owner,
          resolver: ownedResolver,
          status: 'REGISTERED',
        })
        expect(await fork.ens('available', name)).toMatchObject({ available: false })
      })
    })
  })
}
