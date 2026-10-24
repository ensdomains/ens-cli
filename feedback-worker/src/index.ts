import type { D1Database, ExecutionContext } from '@cloudflare/workers-types'

interface Env {
  DB: D1Database
  // Optional Slack Workflow webhook with `message` and `from` variables:
  //   bunx wrangler secret put SLACK_WEBHOOK_URL -c feedback-worker/wrangler.jsonc
  SLACK_WEBHOOK_URL?: string
}

type Feedback = {
  message: string
  name: string | null
  contact: string | null
}

const MAX_MESSAGE_LENGTH = 5000
const MAX_FIELD_LENGTH = 200
// Room for a max-length message even if every character is JSON-escaped
const MAX_BODY_BYTES = 64 * 1024

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'POST') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      )
    }

    const text = await readBody(req)
    if (text === null) {
      return Response.json({ error: 'Request body too large' }, { status: 413 })
    }

    const feedback = parseFeedback(parseJson(text))
    if (typeof feedback === 'string') return Response.json({ error: feedback }, { status: 400 })

    await env.DB.prepare('INSERT INTO feedback (message, name, contact) VALUES (?, ?, ?)')
      .bind(feedback.message, feedback.name, feedback.contact)
      .run()

    if (env.SLACK_WEBHOOK_URL) ctx.waitUntil(sendToSlack(env.SLACK_WEBHOOK_URL, feedback))

    return Response.json({ ok: true }, { status: 201 })
  },
}

// Reads the body as text, or returns null if it exceeds MAX_BODY_BYTES. Content-Length
// alone isn't enough since chunked requests don't send it. Oversized bodies are drained
// without being buffered, so memory stays bounded.
async function readBody(req: Request): Promise<string | null> {
  if (!req.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req.body) {
    size += chunk.byteLength
    if (size <= MAX_BODY_BYTES) chunks.push(chunk)
  }
  return size > MAX_BODY_BYTES ? null : new Blob(chunks).text()
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Returns the parsed feedback, or an error message if the body is invalid.
function parseFeedback(body: unknown): Feedback | string {
  if (typeof body !== 'object' || body === null) return 'Body must be a JSON object'
  const { message, name, contact } = body as Record<string, unknown>

  if (typeof message !== 'string' || !message.trim()) return '`message` is required'
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `\`message\` must be at most ${MAX_MESSAGE_LENGTH} characters`
  }

  const optionalFields = { name, contact }
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return `\`${key}\` must be a string`
    if (value.length > MAX_FIELD_LENGTH) {
      return `\`${key}\` must be at most ${MAX_FIELD_LENGTH} characters`
    }
  }

  return {
    message: message.trim(),
    name: optionalString(name),
    contact: optionalString(contact),
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function sendToSlack(webhookUrl: string, feedback: Feedback) {
  // Collapse whitespace in single-line fields so they can't fake extra lines in the message
  const name = feedback.name && feedback.name.replace(/\s+/g, ' ')
  const contact = feedback.contact && feedback.contact.replace(/\s+/g, ' ')
  const from = name && contact ? `${name} (${contact})` : name || contact || 'Anonymous'
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: escapeSlack(feedback.message), from: escapeSlack(from) }),
  })
  if (!res.ok) console.error(`Slack webhook failed: ${res.status} ${await res.text()}`)
}

// Escape Slack's control characters so user input can't trigger mentions like <!channel>
// or disguise links. See https://api.slack.com/reference/surfaces/formatting#escaping
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
