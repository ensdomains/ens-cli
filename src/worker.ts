import { cli } from './cli.ts'

export default {
  fetch: (req: Request) => cli.fetch(req),
}
