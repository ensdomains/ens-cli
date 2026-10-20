import type { Subprocess } from 'bun'
import {
  createTestClient,
  http,
  parseEther,
  publicActions,
  walletActions,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'

const root = new URL('..', import.meta.url).pathname

export type Fork = Awaited<ReturnType<typeof startFork>>

/** Starts an anvil fork that impersonates every sender, so tests can act as any name owner. */
export async function startFork(opts: {
  chain: 'mainnet' | 'sepolia'
  forkUrl: string
  forkBlock?: string
}) {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const rpc = `http://127.0.0.1:${port}`
  // Public RPCs prune history, so forks default to near the head. Load-balanced nodes can lag
  // it; fork a few blocks back so every node has it. Pin a block with an archive RPC instead.
  const forkBlock = opts.forkBlock
    ? BigInt(opts.forkBlock)
    : (await createTestClient({ mode: 'anvil', transport: http(opts.forkUrl) })
        .extend(publicActions)
        .getBlockNumber()) - 10n
  const anvil: Subprocess = Bun.spawn(
    [
      'anvil',
      '--fork-url',
      opts.forkUrl,
      '--fork-block-number',
      String(forkBlock),
      '--port',
      String(port),
      '--auto-impersonate',
      '--silent',
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )

  const client = createTestClient({ mode: 'anvil', transport: http(rpc) })
    .extend(publicActions)
    .extend(walletActions)

  for (let attempt = 0; ; attempt++) {
    try {
      await client.getChainId()
      break
    } catch {
      if (attempt > 60 || anvil.exitCode != null) {
        const stderr = await new Response(anvil.stderr as ReadableStream).text()
        throw new Error(`anvil did not start: ${stderr}`)
      }
      await Bun.sleep(500)
    }
  }

  /** Runs the CLI and returns its JSON output, throwing the CLI's error message on failure. */
  function ens<T = any>(...args: string[]): Promise<T> {
    return ensVia<T>(rpc, ...args)
  }

  async function ensVia<T = any>(rpcUrl: string, ...args: string[]): Promise<T> {
    const proc = Bun.spawn(
      ['bun', 'src/index.ts', ...args, '--chain', opts.chain, '--rpc', rpcUrl, '--format', 'json'],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    let output: any
    try {
      output = JSON.parse(stdout)
    } catch {
      throw new Error(`ens ${args.join(' ')} printed non-JSON output:\n${stdout}${stderr}`)
    }
    if (exitCode !== 0) throw new CliError(output.message ?? stdout, output)
    return output
  }

  /** Broadcasts CLI calldata from `from` and requires the transaction to succeed. */
  async function send(from: Address, tx: { to: Address; data: Hex; value?: string }) {
    const request = { account: from, to: tx.to, data: tx.data, value: BigInt(tx.value ?? '0') }
    // Like a wallet, pad the estimate: anvil's estimates on forks can come up short.
    const gas = ((await client.estimateGas(request)) * 3n) / 2n
    const hash = await client.sendTransaction({ ...request, gas, chain: null })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      // Replay against the parent block to surface the revert reason.
      const reason = await client.call({ ...request, blockNumber: receipt.blockNumber - 1n }).then(
        () => 'no revert on replay',
        (error: Error) => error.message.split('\n').slice(0, 3).join(' '),
      )
      throw new Error(`transaction to ${tx.to} reverted (gas ${receipt.gasUsed}/${gas}): ${reason}`)
    }
    return receipt
  }

  async function write(
    from: Address,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
  ) {
    const hash = await client.writeContract({
      account: from,
      chain: null,
      address,
      abi,
      functionName,
      args,
    } as any)
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`)
    return receipt
  }

  /** Proxies the fork, answering requests that match `fail` with a JSON-RPC internal error. */
  function faultyRpc(fail: (body: string) => boolean) {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text()
        if (fail(body)) {
          const { id } = JSON.parse(body)
          const error = {
            code: -32603,
            message: 'Internal error: upstream temporarily unavailable',
          }
          return Response.json({ jsonrpc: '2.0', id, error })
        }
        return fetch(rpc, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
      },
    })
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  }

  /** A fresh funded address, so runs never collide with existing state on the forked chain. */
  async function account() {
    const address = privateKeyToAddress(generatePrivateKey())
    await fund(address)
    return address
  }

  async function fund(address: Address) {
    await client.setBalance({ address, value: parseEther('100') })
  }

  async function advance(seconds: number) {
    await client.increaseTime({ seconds })
    await client.mine({ blocks: 1 })
  }

  async function now() {
    return (await client.getBlock()).timestamp
  }

  return {
    rpc,
    client,
    ens,
    ensVia,
    faultyRpc,
    send,
    write,
    account,
    fund,
    advance,
    now,
    stop: () => anvil.kill(),
  }
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly output: unknown,
  ) {
    super(message)
  }
}

/** A label that has never been registered, so each run starts from AVAILABLE. */
export function freshLabel(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
