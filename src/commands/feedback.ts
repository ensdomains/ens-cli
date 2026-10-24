import { Cli, z } from 'incur'

// TODO: replace with the deployed feedback-worker URL before merging.
const FEEDBACK_API_URL = 'https://ens-cli-feedback.example.workers.dev'

export const feedbackCommand = Cli.create('feedback', {
  description: 'Send feedback about the ENS CLI to the maintainers',
  args: z.object({
    message: z.string().min(1).describe('Feedback text to send'),
  }),
  options: z.object({
    name: z.string().optional().describe('Your name'),
    contact: z.string().optional().describe('How to reach you (email, Telegram, X, etc.)'),
  }),
  async run(c) {
    const res = await fetch(FEEDBACK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: c.args.message,
        name: c.options.name,
        contact: c.options.contact,
      }),
    })
    if (!res.ok) throw new Error(`Failed to send feedback: ${res.status} ${res.statusText}`)
    return { sent: true }
  },
})
