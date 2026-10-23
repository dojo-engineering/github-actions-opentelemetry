export type RunnerOs = 'linux' | 'windows' | 'macos' | 'unknown'
export type RunnerArch = 'arm64' | 'amd64' | 'unknown'

export type BillableMetrics = {
  readonly rawBillableMinutes: number
  readonly billableMinutes: number
  readonly roundingWasteSec: number
  readonly multiplier: number
  readonly runnerOs: RunnerOs
  readonly runnerArch: RunnerArch
  readonly runsOn: string | undefined
}

export const detectRunnerOs = (
  labels?: readonly string[]
): { os: RunnerOs; multiplier: number } => {
  if (!labels || labels.length === 0) {
    return { os: 'unknown', multiplier: 1 }
  }

  const normalized = labels.map(l => l.toLowerCase())

  if (normalized.some(l => l.includes('macos'))) {
    return { os: 'macos', multiplier: 10 }
  }
  if (normalized.some(l => l.includes('windows'))) {
    return { os: 'windows', multiplier: 2 }
  }
  if (normalized.some(l => l.includes('ubuntu') || l.includes('linux'))) {
    return { os: 'linux', multiplier: 1 }
  }

  return { os: 'unknown', multiplier: 1 }
}

export const detectRunnerArch = (labels?: readonly string[]): RunnerArch => {
  if (!labels || labels.length === 0) {
    return 'unknown'
  }

  const normalized = labels.map(l => l.trim().toLowerCase())

  for (const label of normalized) {
    if (
      /\b(arm64|aarch64|arm)\b/.test(label) ||
      label.endsWith('-arm') ||
      label.includes('-arm-') ||
      label.includes('-arm64')
    ) {
      return 'arm64'
    }
    if (
      /\b(amd64|x64|x86_64|x86|intel)\b/.test(label) ||
      label.includes('-x64') ||
      label.includes('-amd64')
    ) {
      return 'amd64'
    }
  }

  for (const label of normalized) {
    if (/^macos-(?:\d+|latest)-xlarge(?:-|$)/.test(label)) {
      return 'arm64'
    }
    if (/^macos-(?:\d+|latest)-large(?:-|$)/.test(label)) {
      return 'amd64'
    }
    if (/^macos-(14|15|latest)(\b|-)/.test(label)) {
      return 'arm64'
    }
    if (/^macos-(11|12|13)(\b|-)/.test(label)) {
      return 'amd64'
    }
    if (label.startsWith('ubuntu-') || label.startsWith('windows-')) {
      return 'amd64'
    }
  }

  return 'unknown'
}

export const normalizeRunsOn = (
  labels?: readonly string[]
): string | undefined => {
  if (!labels || labels.length === 0) {
    return undefined
  }

  const cleaned = labels.map(l => l.trim().toLowerCase()).filter(l => l !== '')

  if (cleaned.length === 0) {
    return undefined
  }

  return [...cleaned].sort((a, b) => a.localeCompare(b)).join(',')
}

export const calcJobBillable = (
  durationSec: number,
  conclusion: string,
  labels?: readonly string[]
): BillableMetrics => {
  const { os: runnerOs, multiplier } = detectRunnerOs(labels)
  const runnerArch = detectRunnerArch(labels)
  const runsOn = normalizeRunsOn(labels)
  const isSelfHosted =
    labels?.some(label => label.trim().toLowerCase() === 'self-hosted') ?? false
  const billableMultiplier = isSelfHosted ? 0 : multiplier

  if (isSelfHosted || conclusion === 'skipped' || durationSec <= 0) {
    return {
      rawBillableMinutes: 0,
      billableMinutes: 0,
      roundingWasteSec: 0,
      multiplier: billableMultiplier,
      runnerOs,
      runnerArch,
      runsOn
    }
  }

  const rawBillableMinutes = Math.max(1, Math.ceil(durationSec / 60))
  const roundingWasteSec = rawBillableMinutes * 60 - durationSec
  const billableMinutes = rawBillableMinutes * billableMultiplier

  return {
    rawBillableMinutes,
    billableMinutes,
    roundingWasteSec,
    multiplier: billableMultiplier,
    runnerOs,
    runnerArch,
    runsOn
  }
}
