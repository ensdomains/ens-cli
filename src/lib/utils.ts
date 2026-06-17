import { isHex } from 'viem/utils'
import { normalize } from 'viem/ens'

export const ONE_YEAR = 31536000n

export function validateName(name: string): string {
  if (!name.trim()) {
    throw new Error('Name cannot be empty.')
  }
  let normalized: string
  try {
    normalized = normalize(name)
  } catch {
    throw new Error(`Invalid ENS name: "${name}". Could not normalize name.`)
  }
  if (!normalized.includes('.')) {
    throw new Error(
      `Invalid ENS name: "${normalized}". Expected a fully qualified name (e.g. name.eth).`,
    )
  }
  return normalized
}

/** Returns the label of a 2LD .eth name (e.g. "name" for "name.eth"), or null for anything else. */
export function eth2ldLabel(name: string): string | null {
  const parts = name.split('.')
  return parts.length === 2 && parts[1] === 'eth' ? parts[0]! : null
}

export function extractLabel(name: string): string {
  const normalized = validateName(name)
  const label = eth2ldLabel(normalized)
  if (label == null) {
    throw new Error(`Registration only supports 2LDs (e.g. name.eth). Got: ${normalized}`)
  }
  if (label.length < 3) {
    throw new Error(
      `Name "${label}.eth" is too short. The registrar requires labels of at least 3 characters.`,
    )
  }
  return label
}

export function asHex(value: string, field: string): `0x${string}` {
  if (!isHex(value)) {
    throw new Error(`Invalid ${field}: expected 0x-prefixed hex, got "${value}"`)
  }
  return value
}

export function durationFromOption(duration: number | undefined): bigint {
  return duration != null ? BigInt(duration) : ONE_YEAR
}
