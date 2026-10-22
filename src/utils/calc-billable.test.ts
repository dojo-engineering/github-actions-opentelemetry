import { describe, test, expect } from 'vitest'
import {
  detectRunnerOs,
  detectRunnerArch,
  normalizeRunsOn,
  calcJobBillable
} from './calc-billable.js'

describe('detectRunnerOs', () => {
  test('should detect linux and 1x multiplier for ubuntu/linux labels', () => {
    expect(detectRunnerOs(['ubuntu-latest'])).toEqual({
      os: 'linux',
      multiplier: 1
    })
    expect(detectRunnerOs(['self-hosted', 'Linux'])).toEqual({
      os: 'linux',
      multiplier: 1
    })
  })

  test('should detect windows and 2x multiplier for windows labels', () => {
    expect(detectRunnerOs(['windows-latest'])).toEqual({
      os: 'windows',
      multiplier: 2
    })
    expect(detectRunnerOs(['Windows-2022'])).toEqual({
      os: 'windows',
      multiplier: 2
    })
  })

  test('should detect macos and 10x multiplier for macos labels', () => {
    expect(detectRunnerOs(['macos-14'])).toEqual({
      os: 'macos',
      multiplier: 10
    })
    expect(detectRunnerOs(['macOS-latest'])).toEqual({
      os: 'macos',
      multiplier: 10
    })
  })

  test('should return unknown and 1x multiplier when labels are missing or unrecognized', () => {
    expect(detectRunnerOs(undefined)).toEqual({
      os: 'unknown',
      multiplier: 1
    })
    expect(detectRunnerOs([])).toEqual({
      os: 'unknown',
      multiplier: 1
    })
    expect(detectRunnerOs(['self-hosted', 'custom-runner'])).toEqual({
      os: 'unknown',
      multiplier: 1
    })
  })
})

describe('detectRunnerArch', () => {
  test('should detect arm64 from explicit labels and suffixes', () => {
    expect(detectRunnerArch(['ubuntu-24.04-arm'])).toBe('arm64')
    expect(detectRunnerArch(['windows-11-arm'])).toBe('arm64')
    expect(detectRunnerArch(['self-hosted', 'linux', 'ARM64'])).toBe('arm64')
    expect(detectRunnerArch(['aarch64-runner'])).toBe('arm64')
    expect(detectRunnerArch(['dojo-arm-large'])).toBe('arm64')
    expect(detectRunnerArch(['dojo-arm64'])).toBe('arm64')
  })

  test('should detect amd64 from explicit labels', () => {
    expect(detectRunnerArch(['self-hosted', 'linux', 'X64'])).toBe('amd64')
    expect(detectRunnerArch(['amd64'])).toBe('amd64')
    expect(detectRunnerArch(['x86_64'])).toBe('amd64')
    expect(detectRunnerArch(['macos-15-intel'])).toBe('amd64')
    expect(detectRunnerArch(['runner-x64'])).toBe('amd64')
    expect(detectRunnerArch(['runner-amd64'])).toBe('amd64')
  })

  test('should infer architecture from standard GitHub-hosted runner images', () => {
    expect(detectRunnerArch(['macos-14'])).toBe('arm64')
    expect(detectRunnerArch(['macos-14-large'])).toBe('amd64')
    expect(detectRunnerArch(['macos-15-large'])).toBe('amd64')
    expect(detectRunnerArch(['macos-14-xlarge'])).toBe('arm64')
    expect(detectRunnerArch(['macos-15-xlarge'])).toBe('arm64')
    expect(detectRunnerArch(['macos-latest-large'])).toBe('amd64')
    expect(detectRunnerArch(['macos-latest-xlarge'])).toBe('arm64')
    expect(detectRunnerArch(['macos-latest'])).toBe('arm64')
    expect(detectRunnerArch(['macos-13'])).toBe('amd64')
    expect(detectRunnerArch(['macos-12'])).toBe('amd64')
    expect(detectRunnerArch(['ubuntu-latest'])).toBe('amd64')
    expect(detectRunnerArch(['ubuntu-22.04'])).toBe('amd64')
    expect(detectRunnerArch(['windows-latest'])).toBe('amd64')
  })

  test('should return unknown when architecture cannot be determined', () => {
    expect(detectRunnerArch(undefined)).toBe('unknown')
    expect(detectRunnerArch([])).toBe('unknown')
    expect(detectRunnerArch(['self-hosted', 'linux'])).toBe('unknown')
  })
})

describe('normalizeRunsOn', () => {
  test('should return undefined for empty or missing labels', () => {
    expect(normalizeRunsOn(undefined)).toBeUndefined()
    expect(normalizeRunsOn([])).toBeUndefined()
    expect(normalizeRunsOn(['   '])).toBeUndefined()
  })

  test('should normalize and sort labels deterministically', () => {
    expect(normalizeRunsOn(['Ubuntu-Latest'])).toBe('ubuntu-latest')
    expect(normalizeRunsOn(['self-hosted', 'Linux', 'ARM64'])).toBe(
      'arm64,linux,self-hosted'
    )
  })
})

describe('calcJobBillable', () => {
  test('should round up to nearest minute and compute rounding waste for Linux job', () => {
    // 13s execution -> 1 raw billable min (60s) -> 47s rounding waste
    expect(calcJobBillable(13, 'success', ['ubuntu-latest'])).toEqual({
      rawBillableMinutes: 1,
      billableMinutes: 1,
      roundingWasteSec: 47,
      multiplier: 1,
      runnerOs: 'linux',
      runnerArch: 'amd64',
      runsOn: 'ubuntu-latest'
    })
  })

  test('should apply 10x multiplier for macOS job', () => {
    // 235s (3m 55s) -> 4 raw billable min (240s) -> 5s waste, 40 billable minutes
    expect(calcJobBillable(235, 'success', ['macos-14'])).toEqual({
      rawBillableMinutes: 4,
      billableMinutes: 40,
      roundingWasteSec: 5,
      multiplier: 10,
      runnerOs: 'macos',
      runnerArch: 'arm64',
      runsOn: 'macos-14'
    })
  })

  test('should apply 2x multiplier for Windows job on exact minute boundary', () => {
    // 120s (2m 0s) -> 2 raw billable min -> 0s waste, 4 billable minutes
    expect(calcJobBillable(120, 'failure', ['windows-latest'])).toEqual({
      rawBillableMinutes: 2,
      billableMinutes: 4,
      roundingWasteSec: 0,
      multiplier: 2,
      runnerOs: 'windows',
      runnerArch: 'amd64',
      runsOn: 'windows-latest'
    })
  })

  test('should return 0 billable time and 0 waste for skipped or 0s jobs', () => {
    expect(calcJobBillable(0, 'skipped', ['ubuntu-latest'])).toEqual({
      rawBillableMinutes: 0,
      billableMinutes: 0,
      roundingWasteSec: 0,
      multiplier: 1,
      runnerOs: 'linux',
      runnerArch: 'amd64',
      runsOn: 'ubuntu-latest'
    })
    expect(calcJobBillable(0, 'success', ['ubuntu-latest'])).toEqual({
      rawBillableMinutes: 0,
      billableMinutes: 0,
      roundingWasteSec: 0,
      multiplier: 1,
      runnerOs: 'linux',
      runnerArch: 'amd64',
      runsOn: 'ubuntu-latest'
    })
  })

  test('should exclude self-hosted jobs from GitHub billing and preserve runner metadata', () => {
    expect(
      calcJobBillable(61, 'success', ['self-hosted', 'Windows-2022', 'X64'])
    ).toEqual({
      rawBillableMinutes: 0,
      billableMinutes: 0,
      roundingWasteSec: 0,
      multiplier: 0,
      runnerOs: 'windows',
      runnerArch: 'amd64',
      runsOn: 'self-hosted,windows-2022,x64'
    })
  })
})
