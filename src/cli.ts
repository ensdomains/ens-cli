import { Cli } from 'incur'
import packageJson from '../package.json'
import { getCommands } from './commands/get.ts'
import { availableCommand } from './commands/available.ts'
import { priceCommand } from './commands/price.ts'
import { registerCommands } from './commands/register.ts'
import { renewCommand } from './commands/renew.ts'
import { resolverCommands } from './commands/resolver.ts'
import { setCommands } from './commands/set.ts'
import { subnameCommands } from './commands/subname.ts'
import { subregistryCommands } from './commands/subregistry.ts'
import { whoisCommand } from './commands/whois.ts'

export const cli = Cli.create('ens', {
  version: packageJson.version,
  description: 'Read ENS data and generate unsigned transaction calldata for name management.',
  mcp: {
    command: 'npx "https://pkg.pr.new/ensdomains/cli/@ensdomains/cli@main" --mcp',
  },
})
  // Resolution
  .command(getCommands)
  // Queries
  .command(availableCommand)
  .command(priceCommand)
  .command(whoisCommand)
  // Write operations (calldata output)
  .command(renewCommand)
  .command(registerCommands)
  .command(resolverCommands)
  .command(setCommands)
  .command(subnameCommands)
  .command(subregistryCommands)
