import { describe, expect, test } from 'bun:test'
import { addresses } from './contracts.ts'

describe('ENSv2 Sepolia deployment', () => {
  test('uses the canonical 2026-07-30 deployment', () => {
    expect(addresses.sepolia.v2).toEqual({
      registry: '0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2',
      registrar: '0xa88553F454b77203B0D036A05c894d555EAAa2Cc',
      paymentToken: '0x768F42455A2D082E23ceeF7d51e5787C82d67a39',
      resolverFactory: '0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef',
      resolverImplementation: '0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e',
      resolverProxyLogic: '0xA136BeE4E37B44586242e516a39893EfD54315e9',
      subregistryImplementation: '0x624a25d67B59D587752EbEc8DdeD8827dAe52050',
      lockedMigrationController: '0x5c39E36a69A9897F08954c71aCB1F36E0Bd4f409',
      unlockedMigrationController: '0x2FCf83232b93bD29C59dB18AaA1D4b62e9f9FC73',
    })
  })
})
