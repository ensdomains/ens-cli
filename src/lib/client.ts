import { createPublicClient, http, fallback } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import type { Chain } from './contracts.ts'

const defaultRpcs = {
  mainnet: ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth'],
  sepolia: ['https://1rpc.io/sepolia', 'https://ethereum-sepolia-rpc.publicnode.com'],
} as const

const chains = { mainnet, sepolia } as const

export function createEnsClient({ rpc, chain = 'mainnet' }: { rpc?: string; chain?: Chain }) {
  const transports = [...(rpc ? [http(rpc)] : []), ...defaultRpcs[chain].map((url) => http(url))]

  return createPublicClient({
    chain: chains[chain],
    transport: fallback(transports),
  })
}
