# ENS CLI

> [!WARNING]
> This is an experimental ENS CLI preview. It is not production-ready, not released on npm, and may include frequent breaking changes.
>
> Do not rely on it for production workflows, high-value ENS names, or critical ENS management.

A command-line tool for interacting with ENS (Ethereum Name Service). Built for autonomous AI agents but works for humans too.

The CLI handles two categories of operations:

- **Read operations** (resolution, availability, pricing) execute directly and return results.
- **Write operations** (registration, renewal, record setting) output unsigned calldata as JSON (`{to, data, value}`) for the caller to sign and broadcast. For testing, you can send transactions with raw calldata at [transact.swiss-knife.xyz/send-tx](https://transact.swiss-knife.xyz/send-tx).

Built with [Incur](https://github.com/wevm/incur) for agent-native features (MCP server mode, skills, token-efficient output) and [viem](https://viem.sh) for ENS resolution with full CCIP-read support.

## Install preview build

```sh
alias ens='npx "https://pkg.pr.new/ensdomains/cli/@ensdomains/cli@main"'
ens
```

This creates a temporary `ens` alias for the current shell session. To make it permanent, add the line to your `~/.zshrc` or `~/.bashrc`. There are two ways to pick a build:

- **Track the latest main build** (as above): the `@main` tag always points to the most recent build from the main branch. To pick up a newer build after main has moved, clear your npx cache.
- **Pin a specific commit**: replace `main` in the URL with a commit hash (e.g. `@ensdomains/cli@COMMIT_HASH`). To update, change the hash in the alias.

To remove stale cached versions, clear your npx cache:

```sh
npx clear-npx-cache
```

## Commands

### Resolution

```sh
# Forward resolve a name to an address
ens get address vitalik.eth
ens get address vitalik.eth --coin-type 0  # BTC address

# Reverse resolve an address to a name
ens get name 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045

# Get a text record
ens get text vitalik.eth --key url
ens get text vitalik.eth --key com.twitter

# Get avatar URL
ens get avatar vitalik.eth

# Show owner, resolver, and expiry for a .eth name
ens whois vitalik.eth
```

### Availability & Pricing

```sh
# Check if a name is available
ens available myname.eth

# Check registration/renewal cost
ens price myname.eth
ens price myname.eth --duration 63072000  # 2 years
```

### Registration (commit/reveal)

Registration is a two-step process. Both commands output calldata JSON.

```sh
# Step 1: Generate commit transaction
ens register commit myname.eth --owner 0xYourAddress --json
# Returns: { to, data, value, secret, ... }
# SAVE THE SECRET — you need it for step 2

# Step 2: Wait 60+ seconds after commit is mined, then generate register transaction
ens register reveal myname.eth \
  --owner 0xYourAddress \
  --secret 0x... \
  --value 2307947853431408 \
  --json
# Returns: { to, data, value }
```

Options for both commands: `--duration` (seconds, default 1 year) and `--resolver`. `--reverse-record` is ENSv1-only; it does not deploy or select an ENSv2 resolver and does not create forward resolution. After ENSv2 registration, use `ens set name <name>` to set the owner's reverse record separately.

On ENSv2 (Sepolia), `--resolver` defaults to the owner's deployed permissioned resolver when the canonical owned resolver already exists; otherwise it falls back to the zero address, registering a name with no resolver. Do not broadcast a zero-resolver commitment unless that is intentional. Generate `ens resolver deploy` first (see below), optionally initialize the name's address/text records in that deployment, and pass its predicted `resolver` address explicitly to both commit and reveal. The predicted address can be committed before its deployment transaction is broadcast, so the resolver can be deployed during the commitment wait.

### Resolver management

Change the resolver for an already-registered name. Auto-routes between the v2 registry, the v1 NameWrapper (for wrapped names), and the v1 ENS registry (for unwrapped names).

```sh
ens resolver set myname.eth --resolver 0xResolverAddr --chain sepolia
# Returns: { to, data, value, version, wrapped, ... }
```

Transaction must be sent from the name owner (or an approved operator).

### Reverse record

Set the transaction sender's ETH reverse record.

```sh
ens set name myname.eth
# Returns: { to, data, value, name, reverseRegistrar }

# Clear the reverse record
ens set name ''
```

The generated transaction must be sent from the address whose reverse record should be changed. A reverse record is only one half of a primary name. A functional primary name requires a bidirectional match: the name must forward-resolve to that same address, and the address's reverse record must point back to the name.

### Resolver deployment (ENSv2)

ENSv2 names use an OwnedResolver, a per-account `PermissionedResolver` proxy. The v1 Public Resolver can't be reused for updates because its authorisation is gated by the v1 registry, which knows nothing about v2-registered names. Each owner can deploy their own resolver through the v2 `VerifiableFactory`; ENSv2 registration, migration, and subname creation commands use that resolver by default when it is already deployed.

```sh
# Predicts the CREATE2 address and emits deployProxy calldata.
# alreadyDeployed=true short-circuits when the resolver already exists.
ens resolver deploy 0xYourAddress --chain sepolia --json
# Returns: { to, data, value, resolver, alreadyDeployed, ... }

# Deploy a new resolver and initialize records atomically.
ens resolver deploy 0xYourAddress \
  --name myname.eth \
  --records '[{"type":"address","address":"0xYourAddress","coinType":60},{"type":"text","key":"url","value":"https://example.com"}]' \
  --chain sepolia \
  --json
```

The resolver address is derived from `(factory, proxyLogic, deployer, salt)`, so the deploy transaction must be sent from `deployer`. The salt defaults to `keccak256(abi.encode(keccak256("OwnedResolver"), owner, 0))` where `owner` is the admin the resolver is initialized with — the canonical scheme shared with the contracts-v2 setup script and the manager app's migration flow, so the resolver can be rediscovered from the owner address alone.

`--name` and `--records` must be used together. On a new resolver, the address, text, and contenthash operations use `PermissionedResolver.initialize(..., setters)` to initialize records in the deployment transaction, avoiding a later `ens set batch` transaction. If the resolver is already deployed, use `ens set batch` instead. The predicted resolver address can be used in a registration commitment before deployment, so deployment and record initialization can happen during the commitment waiting period.

Other options: `--admin` (defaults to deployer), `--salt` (decimal or 0x hex), `--role-bitmap` (decimal or 0x hex, default `0x1111…1111`).

### Subregistry management (ENSv2)

ENSv2 subnames are created inside a parent name's subregistry. A name must have a subregistry set before `ens subname create` can register children under it.

```sh
# Deploy a UserRegistry for a name if it does not already have one.
ens subregistry deploy parent.eth --deployer 0xYourAddress --chain sepolia --json

# Wire the deployed registry into the parent name.
ens subregistry set parent.eth --registry 0xSubregistry --chain sepolia
```

`subregistry deploy` returns `alreadySet=true` when the name already has a subregistry. The proxy address is derived from `(factory, deployer, salt)`, so the deploy transaction must be sent from `--deployer`. The default salt is `keccak256(abi.encode(keccak256("UserRegistry"), namehash(name), 0))`, and the default initializer grants the root account all UserRegistry roles.

### Renewal

```sh
# Check cost first
ens price myname.eth

# Generate renewal calldata
ens renew myname.eth --value 2307947853431408 --json
```

### Migrating from ENSv1 to ENSv2

Generate the one-way migration transaction for a pre-migrated (reserved) `.eth` 2LD. The command reads the v1 owner, resolver, wrapping state, and fuses, then targets the unlocked or locked migration controller as appropriate.

```sh
ens migrate myname.eth --chain sepolia --json
# Returns: { to, data, value, kind, currentOwner, owner, controller, ... }

# Optionally change v2 configuration during migration
ens migrate myname.eth \
  --chain sepolia \
  --owner 0xNewOwner \
  --resolver 0xResolver \
  --subregistry 0xSubregistry
```

The transaction must be sent by the current ENSv1 token owner or an approved operator. Unwrapped names transfer the Base Registrar ERC-721 to the unlocked controller. Wrapped names transfer the NameWrapper ERC-1155 to either the unlocked or locked controller based on `CANNOT_UNWRAP`. Locked migration deploys its own `WrapperRegistry`, so `--subregistry` is ignored in that case.

Unless `--resolver` is provided, migration uses the new owner's canonical OwnedResolver when it is already deployed. Otherwise it preserves the current ENSv1 resolver for record continuity and returns a flag recommending that an OwnedResolver be deployed before regenerating the migration. Locked names with `CANNOT_SET_RESOLVER` are excluded because their resolver payload is ignored.

Wrapped-name flags also describe how the command inferred the migration path, the sender authorization it assumes, and any fuse-dependent behavior to review before broadcasting. For example, `CANNOT_APPROVE` with a frozen token approval is expected to revert.

Migration only works after the name has been reserved in ENSv2 and cannot be reversed. Names in the ENSv1 grace period must be renewed through `ETHRenewerV1` before migration. Test on Sepolia before migrating valuable names.

### Subnames

Generate calldata to create a subname under a parent you own. On ENSv2, the command walks the registry hierarchy and targets the parent's subregistry. If the parent has no subregistry, deploy one with `ens subregistry deploy` and set it with `ens subregistry set` first. On ENSv1, the command reads the parent's onchain owner; if the parent is wrapped in the NameWrapper, the calldata targets the NameWrapper instead of the registry.

```sh
# Create an ENSv2 subname under a parent with a subregistry
ens subname create sub.parent.eth --owner 0xNewOwner --chain sepolia

# Create a subname under an unwrapped parent (registry.setSubnodeRecord)
ens subname create sub.parent.eth --owner 0xNewOwner

# Create a subname under a wrapped parent (NameWrapper.setSubnodeRecord)
ens subname create sub.wrapped.eth --owner 0xNewOwner --fuses 0 --expiry 0

# Custom resolver
ens subname create sub.parent.eth --owner 0xNewOwner --resolver 0x...
```

Options: `--resolver` (defaults to the owner's deployed resolver on ENSv2 when found, chain public resolver on ENSv1), `--subregistry`, `--duration`, and `--role-bitmap` (ENSv2), `--fuses` and `--expiry` (NameWrapper only, both default to 0).

### Setting Records

All set commands output calldata JSON. The target resolver is read from the Universal Resolver by default — the name must already have a resolver set, otherwise the command errors. Pass `--resolver <address>` to override.

```sh
# Set address record
ens set address myname.eth --address 0x1234...
ens set address myname.eth --address 0x1234... --coin-type 0  # BTC

# Set text record
ens set text myname.eth --key url --value https://example.com
ens set text myname.eth --key com.twitter --value @myhandle

# Set content hash
ens set contenthash myname.eth --hash 0x...

# Batch set multiple records (multicall)
ens set batch myname.eth --data '[
  {"type": "text", "key": "url", "value": "https://example.com"},
  {"type": "text", "key": "com.twitter", "value": "@myhandle"},
  {"type": "address", "address": "0x1234...", "coinType": 60}
]'
```

## Configuration

**RPC endpoint** (in order of precedence):

1. `--rpc <url>` flag
2. `ETH_RPC_URL` environment variable
3. Public fallback RPCs

**Chain selection:**

```sh
ens get address vitalik.eth --chain mainnet  # default
ens get address vitalik.eth --chain sepolia
```

**Output format:**

```sh
ens get address vitalik.eth --json
ens get address vitalik.eth --format yaml
```

## Agent Integration

The CLI has built-in support for AI agent discovery:

```sh
# View the LLM-readable command manifest
ens --llms

# Register as an MCP server
ens mcp add

# Generate skill files for agents
ens skills add

# Run in MCP stdio mode
ens --mcp
```

## Contributing

### Prerequisites

- [Bun](https://bun.sh) v1.0+

### Setup

```sh
git clone https://github.com/ensdomains/ens-cli.git
cd ens-cli
bun install
```

### Running locally

```sh
# Run any command directly
bun src/index.ts get address vitalik.eth

# With a custom RPC
bun src/index.ts get address vitalik.eth --rpc http://localhost:8545

# With environment variable
ETH_RPC_URL=http://localhost:8545 bun src/index.ts available myname.eth
```

### Command design conventions

- **One positional argument per command: the subject it operates on** (an ENS name or an address). Everything else is a named option, whether required or optional. Example: `ens set text myname.eth --key url --value https://example.com` — never `ens set text myname.eth url https://example.com`. Multiple positionals force the caller to memorize parameter order; named options are self-documenting in scripts, shell history, and agent transcripts.
- **Required options are simply non-`.optional()` in the Zod options schema** — validation fails with a clear error if they're missing.
- **No single-character option aliases.** Spell out `--resolver`, not `-r`.
- **Group related commands** (`get`, `set`, `register`, `resolver`, `subname`) rather than adding top-level commands for each operation.

### Adding a command

1. Create a command file in `src/commands/` exporting a function that returns a command definition (for flat commands) or a `Cli.create()` group (for nested subcommands).
2. Follow the command design conventions above.
3. Mount it in `src/cli.ts` via `.command()`.
4. Test against mainnet or a local fork: `bun src/index.ts <your-command>`.
