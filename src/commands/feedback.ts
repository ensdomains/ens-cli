import { Cli, z } from 'incur'
import packageJson from '../../package.json'

// TODO: replace with the real feedback endpoint before merging.
const FEEDBACK_API_URL = 'https://example.com/api/feedback'

export const feedbackCommand = Cli.create('feedback', {
  description: 'Send feedback about the ENS CLI to the maintainers',
  args: z.object({
    message: z.string().min(1).describe('Feedback text to send'),
  }),
  async run(c) {
    const res = await fetch(FEEDBACK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: c.args.message, version: packageJson.version }),
    })
    if (!res.ok) throw new Error(`Failed to send feedback: ${res.status} ${res.statusText}`)
    return { sent: true }
  },
})
