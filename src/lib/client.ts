import { createPublicClient, http, fallback } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import type { Chain } from './contracts.ts'

const defaultRpcs = {
  mainnet: ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth'],
  sepolia: ['https://1rpc.io/sepolia', 'https://ethereum-sepolia-rpc.publicnode.com'],
} as const

const chains = { mainnet, sepolia } as const

export function createEnsClient({ rpc, chain = 'mainnet' }: { rpc?: string; chain?: Chain }) {
  // A user-supplied RPC is used exclusively: falling back to public RPCs could
  // silently build transactions from a different chain state (e.g. a local fork).
  return createPublicClient({
    chain: chains[chain],
    transport: rpc ? http(rpc) : fallback(defaultRpcs[chain].map((url) => http(url))),
  })
}
