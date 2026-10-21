import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as github from './github/index.js'
import * as instrumentation from './instrumentation/index.js'
import { run } from './main.js'
import { opentelemetryAllDisable } from './utils/opentelemetry-all-disable.js'

/**
 * Testing Philosophy for main.test.ts:
 *
 * This test file focuses only on high-level success/failure scenarios of the main workflow.
 * We test at a coarse granularity - whether the overall execution succeeds or fails.
 * Detailed testing of individual modules, functions, and edge cases is handled by
 * unit tests in their respective module test files.
 *
 * This approach keeps the main integration tests simple and focused on the overall
 * workflow behavior rather than implementation details.
 */

// For test error handle
const fetchWorkflowResultsSpy = vi.spyOn(github, 'fetchWorkflowResults')
const getWorkflowContextSpy = vi.spyOn(github, 'getWorkflowContext')
const initializeSpy = vi.spyOn(instrumentation, 'initialize')
const forceFlushSpy = vi.spyOn(instrumentation, 'forceFlush')
const shutdownSpy = vi.spyOn(instrumentation, 'shutdown')

const workflowContext: Parameters<typeof github.fetchWorkflowResults>[1] = {
  owner: 'test-owner',
  repo: 'test-repo',
  runId: 12345,
  attempt_number: 1
}

const workflowResults: Awaited<ReturnType<typeof github.fetchWorkflowResults>> =
  {
    workflow: {
      id: 12345,
      name: 'Test Workflow',
      conclusion: 'success',
      created_at: new Date('2023-01-01T00:00:00Z'),
      run_attempt: 1,
      html_url: 'https://github.com/test-owner/test-repo/actions/runs/12345',
      repository: {
        full_name: 'test-owner/test-repo'
      }
    },
    workflowJobs: [
      {
        id: 12346,
        name: 'Test Job',
        created_at: new Date('2023-01-01T00:01:00Z'),
        started_at: new Date('2023-01-01T00:02:00Z'),
        completed_at: new Date('2023-01-01T00:03:00Z'),
        run_id: 12345,
        status: 'completed',
        conclusion: 'success',
        runner_name: null,
        runner_group_name: null,
        workflow_name: 'Test Workflow',
        steps: []
      }
    ]
  }

describe('run function', () => {
  beforeEach(() => {
    opentelemetryAllDisable()
    fetchWorkflowResultsSpy.mockReset().mockResolvedValue(workflowResults)
    getWorkflowContextSpy.mockReset().mockReturnValue(workflowContext)
    initializeSpy.mockReset().mockImplementation(() => {})
    forceFlushSpy.mockReset().mockResolvedValue(undefined)
    shutdownSpy.mockReset().mockResolvedValue(undefined)
  })
  describe('should exit with expected code', () => {
    test('should run successfully', async () => {
      await expect(run()).rejects.toThrowError(
        'process.exit unexpectedly called with "0"'
      )
      expect(fetchWorkflowResultsSpy).toHaveBeenCalledTimes(1)
      expect(getWorkflowContextSpy).toHaveBeenCalledTimes(1)
      expect(fetchWorkflowResultsSpy).toHaveBeenCalledWith(
        expect.any(Object),
        workflowContext
      )
      expect(initializeSpy).toHaveBeenCalledTimes(1)
      expect(forceFlushSpy).toHaveBeenCalledTimes(1)
      expect(shutdownSpy).toHaveBeenCalledTimes(1)
    })
    test('should exit with 1 when fetching workflow results failed', async () => {
      fetchWorkflowResultsSpy.mockRejectedValueOnce(new Error('test'))
      await expect(run()).rejects.toThrowError(
        'process.exit unexpectedly called with "1"'
      )
      expect(fetchWorkflowResultsSpy).toHaveBeenCalledTimes(1)
      expect(forceFlushSpy).toHaveBeenCalledTimes(1)
      expect(shutdownSpy).toHaveBeenCalledTimes(1)
    })
    test('should exit with 1 when forceFlush failed', async () => {
      forceFlushSpy.mockRejectedValueOnce(new Error('test'))
      await expect(run()).rejects.toThrowError(
        'process.exit unexpectedly called with "1"'
      )
      expect(fetchWorkflowResultsSpy).toHaveBeenCalledTimes(1)
      expect(forceFlushSpy).toHaveBeenCalledTimes(1)
      expect(shutdownSpy).not.toHaveBeenCalled()
    })
  })
})
