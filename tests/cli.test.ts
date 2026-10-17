import { afterAll, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import { namehash, normalize } from 'viem/ens'
import { cli } from '../src/cli.ts'
import {
  addresses,
  ethRegistrarControllerAbi,
  publicResolverAbi,
  universalResolverAbi,
} from '../src/lib/contracts.ts'

const commands = [
  'available',
  'get address',
  'get name',
  'get text',
  'get avatar',
  'migrate',
  'price',
  'register commit',
  'register reveal',
  'renew',
  'resolver deploy',
  'resolver set',
  'set name',
  'set address',
  'set text',
  'set contenthash',
  'set batch',
  'subname create',
  'subregistry deploy',
  'subregistry set',
  'whois',
]
const resolver = '0x0000000000000000000000000000000000000001'

async function run(args: string[], env: Record<string, string> = {}) {
  let stdout = ''
  let code = 0
  await cli.serve(args, {
    stdout: (s) => {
      stdout += s
    },
    exit: (c) => {
      code = c
    },
    env,
  })
  return { stdout, code }
}
async function json(args: string[], env: Record<string, string> = {}) {
  const result = await run([...args, '--json'], env)
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout)
}

test.each(commands)('%s keeps help and JSON schema accessible', async (command) => {
  const args = command.split(' ')
  const help = await run([...args, '--help'])
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('Usage:')
  const schema = await run([...args, '--schema', '--json'])
  expect(schema.code).toBe(0)
  expect(JSON.parse(schema.stdout)).toHaveProperty('args')
})

test('root help, version and command manifest remain available', async () => {
  expect((await run(['--help'])).stdout).toContain('subregistry')
  expect((await run(['--version'])).stdout.trim()).toContain('0.1.0')
  expect((await run(['--llms-full'])).stdout).toContain('renew')
})

test('unsigned renewal preserves value, coerced duration and ABI encoding', async () => {
  const result = await json(['renew', 'RaFFY.eth', '--value', '123', '--duration', '86400'])
  expect(result).toMatchObject({ label: 'raffy', duration: '86400', value: '123' })
  expect(decodeFunctionData({ abi: ethRegistrarControllerAbi, data: result.data })).toMatchObject({
    functionName: 'renew',
    args: ['raffy', 86400n, `0x${'00'.repeat(32)}`],
  })
  expect(result).not.toHaveProperty('hash')
})

test.each(['RaFFY.eth', 'é.eth', '👨‍👩‍👧‍👦.eth'])(
  'normalizes %s before encoding records',
  async (name) => {
    const result = await json([
      'set',
      'text',
      name,
      '--resolver',
      resolver,
      '--key',
      'url',
      '--value',
      'https://example.com',
    ])
    expect(result).toMatchObject({ to: resolver, value: '0' })
    expect(decodeFunctionData({ abi: publicResolverAbi, data: result.data })).toMatchObject({
      functionName: 'setText',
      args: [namehash(normalize(name)), 'url', 'https://example.com'],
    })
  },
)

test('JSON and YAML encode the same unsigned transaction', async () => {
  const args = ['set', 'address', 'raffy.eth', '--resolver', resolver, '--address', resolver]
  const result = await json(args)
  const yaml = await run([...args, '--format', 'yaml'])
  expect(yaml.code).toBe(0)
  expect(Bun.YAML.parse(yaml.stdout)).toEqual(result)
})

test.each(
  [
    ['renew', 'raffy.eth'],
    ['renew', 'raffy.eth', '--value', '0', '--chain', 'invalid'],
    ['renew', 'raffy.eth', '--value', '0', '--duration', 'abc'],
    ['set', 'text', 'bad..eth', '--resolver', resolver, '--key', 'url', '--value', 'x'],
    ['set', 'batch', 'raffy.eth', '--resolver', resolver, '--data', 'not-json'],
    ['unknown-command'],
  ].map((args) => ({ args })),
)('invalid invocation $args exits unsuccessfully', async ({ args }) => {
  const result = await run([...args, '--json'])
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toHaveProperty('code')
})

// Real HTTP transport against a local fixture. Reject all non-fixture fetches so
// an RPC regression cannot silently fall back to public providers.
const nativeFetch = globalThis.fetch
const requests: { endpoint: string; method: string; data: string; to: string }[] = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = (await req.json()) as any
    expect(body.method).toBe('eth_call')
    const data = body.params[0].data as string
    requests.push({
      endpoint: new URL(req.url).pathname,
      method: body.method,
      data,
      to: body.params[0].to,
    })
    let result: string
    if (data.startsWith('0x01ffc9a7')) {
      result = encodeFunctionResult({
        abi: universalResolverAbi,
        functionName: 'supportsInterface',
        result: false,
      })
    } else {
      const call = decodeFunctionData({
        abi: ethRegistrarControllerAbi,
        data: data as `0x${string}`,
      })
      expect(call.functionName).toBe('available')
      expect(call.args).toEqual(['raffy'])
      result = encodeFunctionResult({
        abi: ethRegistrarControllerAbi,
        functionName: 'available',
        result: true,
      })
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  },
})
globalThis.fetch = ((input: any, init: any) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.startsWith(server.url.origin)) throw new Error(`Unexpected external request: ${url}`)
  return nativeFetch(input, init)
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = nativeFetch
  server.stop(true)
})

test('mocked read-only RPC honors env and --rpc precedence', async () => {
  requests.length = 0
  const env = { ETH_RPC_URL: `${server.url}env` }
  expect(await json(['available', 'RaFFY.eth'], env)).toMatchObject({
    label: 'raffy',
    available: true,
  })
  expect(requests.map((r) => r.endpoint)).toEqual(['/env', '/env'])
  expect(requests[1]!.to.toLowerCase()).toBe(addresses.mainnet.controller.toLowerCase())
  requests.length = 0
  expect(
    await json(['available', 'raffy.eth', '--rpc', `${server.url}flag`, '--chain', 'sepolia'], env),
  ).toMatchObject({ available: true })
  expect(requests.map((r) => r.endpoint)).toEqual(['/flag', '/flag'])
  expect(requests[1]!.to.toLowerCase()).toBe(addresses.sepolia.controller.toLowerCase())
  requests.length = 0
  expect(
    await json(['available', 'raffy.eth', '--universalResolver', resolver], env),
  ).toMatchObject({ available: true })
  expect(requests[0]!.to.toLowerCase()).toBe(resolver.toLowerCase())
})

test('MCP stdio initializes, lists all 21 direct tools and calls unsigned renewal', async () => {
  const child = Bun.spawn(
    [
      process.env.ENS_MCP_RUNTIME ?? process.execPath,
      process.env.ENS_MCP_ENTRY ?? 'src/index.ts',
      '--mcp',
    ],
    {
      cwd: import.meta.dir + '/..',
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
    },
  )
  const reader = child.stdout.getReader()
  let buffer = ''
  async function request(id: number, method: string, params: object) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    child.stdin.flush()
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const response = JSON.parse(line)
        if (response.id === id) return response
      } else {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('MCP stdout closed before response')
        buffer += new TextDecoder().decode(chunk.value)
      }
    }
  }
  const timer = setTimeout(() => child.kill(), 10000)
  try {
    const initialized = await request(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ens-test', version: '1' },
    })
    expect(initialized.result.serverInfo.name).toBe('ens')
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    )
    child.stdin.flush()
    const list = await request(2, 'tools/list', {})
    expect(list.result.tools.map((tool: any) => tool.name).sort()).toEqual(
      commands.map((c) => c.replaceAll(' ', '_')).sort(),
    )
    const called = await request(3, 'tools/call', {
      name: 'renew',
      arguments: { name: 'raffy.eth', value: '123' },
    })
    expect(called.result.isError).not.toBe(true)
    const data = JSON.parse(called.result.content[0].text)
    expect(data).toMatchObject({ label: 'raffy', value: '123', duration: '31536000' })
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
}, 15000)

test('HTTP MCP preserves direct tools and unsigned tool calls', async () => {
  async function request(id: number, method: string, params: object) {
    const response = await cli.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    return JSON.parse(text.startsWith('event:') ? text.split('data: ')[1]!.trim() : text)
  }
  const initialized = await request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'ens-test', version: '1' },
  })
  expect(initialized.result.serverInfo.name).toBe('ens')
  const list = await request(2, 'tools/list', {})
  expect(list.result.tools.map((tool: any) => tool.name).sort()).toEqual(
    commands.map((c) => c.replaceAll(' ', '_')).sort(),
  )
  const called = await request(3, 'tools/call', {
    name: 'renew',
    arguments: { name: 'raffy.eth', value: '123' },
  })
  expect(called.result.isError).not.toBe(true)
  expect(JSON.parse(called.result.content[0].text)).toMatchObject({ label: 'raffy', value: '123' })
})
