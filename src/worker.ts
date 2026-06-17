// TEMPORARY MONKEYPATCH — remove once incur ships a stateless MCP-over-HTTP option.
//
// What this file replaces:
//   The trivial `cli.fetch(req)` worker. incur's README advertises Cloudflare
//   Workers as a supported `cli.fetch` target, including the auto-mounted
//   `/mcp` endpoint, but the current implementation breaks under Workers'
//   isolate model.
//
// Why the unpatched version fails:
//   incur's `createMcpHttpHandler` (node_modules/incur/dist/Cli.js) constructs
//   the Streamable HTTP transport in *stateful* mode:
//     new WebStandardStreamableHTTPServerTransport({
//       sessionIdGenerator: () => crypto.randomUUID(),
//       enableJsonResponse: true,
//     })
//   and caches it in a module-level closure (`let transport`). On a long-lived
//   Node/Bun/Deno process that is fine — one transport, one session map, one
//   `isInitialized` flag. On Cloudflare Workers each request can land in a
//   different isolate, so the `isInitialized` flag set during the `initialize`
//   call is gone by the next POST. The result is the exact failure we saw on
//   `ens-mcp.gregskril.workers.dev`:
//     POST /mcp initialize  -> 200, mcp-session-id: <uuid>
//     POST /mcp tools/list  -> 400 {"code":-32000,"message":"Bad Request: Server not initialized"}
//   …which is why Claude Code shows "Failed to reconnect to ens".
//
// What the patch does:
//   Intercept `/mcp` before handing the request to `cli.fetch` and run the
//   same tool registration incur would do, but construct the transport in
//   *stateless* mode (`sessionIdGenerator: undefined`). The MCP SDK
//   (@modelcontextprotocol/server) explicitly supports this — every POST is
//   self-contained, no per-session state, nothing to remember across
//   isolates. Non-`/mcp` routes still go through `cli.fetch` unchanged so the
//   command API, OpenAPI spec, and everything else behave normally.
//
// Caveats:
//   - `Mcp.collectTools`, `Mcp.callTool`, and `Cli.toCommands` are tagged
//     `@internal` in incur. They are re-exported from incur's public index
//     today, but a future incur bump could rename or remove them. `incur` is
//     pinned in package.json; bump it deliberately.
//   - Tool registration runs per request. It's cheap, but if it ever shows up
//     in latency profiles, cache the built `McpServer` in a module-level
//     binding — safe because stateless mode has no cross-request state to
//     leak.
//
// Removal plan:
//   Track https://github.com/wevm/incur for either a `mcp.stateless: true`
//   option on `Cli.create` or a default switch to stateless mode for the HTTP
//   transport. Once shipped, delete this file's body and restore:
//     export default { fetch: (req: Request) => cli.fetch(req) }

import { Cli, Mcp, z } from 'incur'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import packageJson from '../package.json'
import { cli } from './cli.ts'

const NAME = 'ens'
const VERSION = packageJson.version

function buildMcpServer() {
  const server = new McpServer({ name: NAME, version: VERSION })
  for (const tool of Mcp.collectTools(Cli.toCommands.get(cli)!, [])) {
    const shape = { ...tool.command.args?.shape, ...tool.command.options?.shape }
    const hasInput = Object.keys(shape).length > 0
    server.registerTool(
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : {}),
        ...(hasInput ? { inputSchema: z.object(shape) } : {}),
      },
      async (...a) => Mcp.callTool(tool, hasInput ? a[0] : {}, { name: NAME, version: VERSION }),
    )
  }
  return server
}

export default {
  async fetch(req: Request) {
    const url = new URL(req.url)
    if (url.pathname === '/mcp') {
      // Stateless mode: no SSE listening stream, no session to delete. The
      // Streamable HTTP spec says to answer GET/DELETE with 405 so clients
      // stop retrying; the transport otherwise hangs on GET and the Workers
      // runtime kills the request.
      if (req.method !== 'POST') {
        return new Response(null, { status: 405, headers: { allow: 'POST' } })
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await buildMcpServer().connect(transport)
      return transport.handleRequest(req)
    }
    return cli.fetch(req)
  },
}
