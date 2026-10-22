import { describe, test, expect, afterEach, beforeEach } from 'vitest'
import { WorkflowResults } from '../github/index.js'
import {
  InMemorySpanExporter,
  ReadableSpan
} from '@opentelemetry/sdk-trace-base'
import { opentelemetryAllDisable } from '../utils/opentelemetry-all-disable.js'
import { initialize, forceFlush } from '../instrumentation/index.js'
import { createTrace } from './create-trace.js'
import { fail } from 'assert'
import settings from '../settings.js'
import { SpanStatusCode } from '@opentelemetry/api'

const workflowRunResults: WorkflowResults = {
  workflow: {
    created_at: new Date('2024-09-01T00:00:00Z'),
    id: 10000000000,
    name: 'Test Run',
    run_attempt: 14,
    event: 'push',
    repository: {
      full_name: 'test-owner/test-repo'
    },
    conclusion: 'failure',
    html_url: 'http://example.com/workflow_run'
  },
  workflowJobs: [
    {
      created_at: new Date('2024-09-01T00:02:00Z'),
      started_at: new Date('2024-09-01T00:05:00Z'),
      completed_at: new Date('2024-09-01T00:10:00Z'),
      id: 30000000000,
      name: 'job1',
      run_id: 10000000000,
      workflow_name: 'Test Run',
      status: 'completed',
      conclusion: 'success',
      labels: ['ubuntu-latest'],
      steps: [
        {
          name: 'step1_1',
          number: 1,
          started_at: new Date('2024-09-01T00:05:10Z'),
          completed_at: new Date('2024-09-01T00:05:20Z'),
          conclusion: 'success'
        },
        {
          name: 'step1_2',
          number: 2,
          started_at: new Date('2024-09-01T00:05:30Z'),
          completed_at: new Date('2024-09-01T00:05:35Z'),
          conclusion: 'success'
        },
        {
          name: 'step1_3',
          number: 3,
          started_at: new Date('2024-09-01T00:05:40Z'),
          completed_at: new Date('2024-09-01T00:05:50Z'),
          conclusion: 'success'
        }
      ],
      runner_name: null,
      runner_group_name: null
    },
    {
      created_at: new Date('2024-09-01T00:12:00Z'),
      started_at: new Date('2024-09-01T00:15:00Z'),
      completed_at: new Date('2024-09-01T00:20:00Z'),
      id: 30000000001,
      name: 'job2',
      run_id: 10000000000,
      workflow_name: 'Test Run',
      status: 'completed',
      conclusion: 'failure',
      labels: ['macos-14'],
      steps: [
        {
          name: 'step2_1',
          number: 1,
          started_at: new Date('2024-09-01T00:15:10Z'),
          completed_at: new Date('2024-09-01T00:15:20Z'),
          conclusion: 'success'
        },
        {
          name: 'step2_2',
          number: 2,
          started_at: new Date('2024-09-01T00:15:30Z'),
          completed_at: new Date('2024-09-01T00:15:35Z'),
          conclusion: 'success'
        },
        {
          name: 'step2_3',
          number: 3,
          started_at: new Date('2024-09-01T00:15:40Z'),
          completed_at: new Date('2024-09-01T00:15:50Z'),
          conclusion: 'failure'
        }
      ],
      runner_name: null,
      runner_group_name: null
    }
  ]
}
const { workflow: workflowRun, workflowJobs: workflowRunJobs } =
  workflowRunResults

describe('should export expected spans', () => {
  const exporter = new InMemorySpanExporter()

  beforeEach(() => {
    exporter.reset()
    initialize(undefined, exporter)
  })

  afterEach(() => {
    opentelemetryAllDisable()
  })

  test('should verify startTime and endTime', async () => {
    const traceId = await createTrace(workflowRunResults)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/) // OpenTelemetry trace ID format
    expect(typeof traceId).toBe('string')
    await forceFlush()
    const spans = exporter.getFinishedSpans().map(span => ({
      name: span.name,
      startTime: span.startTime,
      endTime: span.endTime
    }))

    let testedSpanCount = 0

    if (!workflowRunJobs[1].completed_at) fail()
    // workflow span
    expect(spans).toContainEqual({
      name: workflowRun.name,
      startTime: [toEpochSec(workflowRun.created_at), 0],
      endTime: [
        toEpochSec(workflowRunJobs[1].completed_at), // last job's completed_at
        0
      ]
    })
    testedSpanCount++

    // jobs span
    for (const job of workflowRunJobs) {
      if (!job.completed_at) fail()
      expect(spans).toContainEqual({
        name: job.name,
        startTime: [toEpochSec(job.started_at), 0],
        endTime: [toEpochSec(job.completed_at), 0]
      })
      testedSpanCount++
    }

    // with waiting for a job span
    for (const job of workflowRunJobs) {
      if (!job.completed_at) fail()
      expect(spans).toContainEqual({
        name: `${job.name} with time of waiting runner`,
        startTime: [toEpochSec(job.created_at), 0],
        endTime: [toEpochSec(job.completed_at), 0]
      })
      testedSpanCount++
    }

    // waiting for a job span (static 'job.queue' name)
    for (const job of workflowRunJobs) {
      expect(spans).toContainEqual({
        name: 'job.queue',
        startTime: [toEpochSec(job.created_at), 0],
        endTime: [toEpochSec(job.started_at), 0]
      })
      testedSpanCount++
    }

    // steps span
    for (const job of workflowRunJobs) {
      job.steps?.map(step => {
        if (!step.started_at || !step.completed_at) fail()
        expect(spans).toContainEqual({
          name: step.name,
          startTime: [toEpochSec(step.started_at), 0],
          endTime: [toEpochSec(step.completed_at), 0]
        })
        testedSpanCount++
      })
    }

    expect(spans).toHaveLength(testedSpanCount)
  })

  test('should export only one root span', async () => {
    const traceId = await createTrace(workflowRunResults)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/) // OpenTelemetry trace ID format
    await forceFlush()

    const spans = exporter.getFinishedSpans().map(span => ({
      parentSpanId: span.parentSpanContext?.spanId
    }))

    const rootSpanCount = spans.filter(v => {
      return v.parentSpanId === undefined
    })

    expect(rootSpanCount).toHaveLength(1)
  })

  test('should verify resource attributes', async () => {
    const traceId = await createTrace(workflowRunResults)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/) // OpenTelemetry trace ID format
    await forceFlush()

    const spans = exporter.getFinishedSpans().map(span => ({
      resourceAttributes: span.resource.attributes
    }))

    spans.map(span => {
      // NOTE: Resource attributes are defined in vitest.config.ts
      expect(span.resourceAttributes).toMatchObject({
        'service.name': 'github-actions-opentelemetry',
        'test.attribute': 'example',
        'test.attribute2': 'example2'
      })
    })
  })

  test('should not export when disable FeatureFlagTrace', async () => {
    settings.FeatureFlagTrace = false
    const traceId = await createTrace(workflowRunResults)
    await forceFlush()

    expect(traceId).toBe('')
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    settings.FeatureFlagTrace = true
  })

  test('should verify span status', async () => {
    const traceId = await createTrace(workflowRunResults)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/) // OpenTelemetry trace ID format
    await forceFlush()

    const spans = exporter.getFinishedSpans()
    if (!workflowRun.name) fail()
    const rootSpan = findSpanByName(spans, workflowRun.name)
    const job1 = findSpanByName(spans, 'job1')
    const job2 = findSpanByName(spans, 'job2')
    const job2WithWaitingTime = findSpanByName(
      spans,
      'job2 with time of waiting runner'
    )
    const job2WaitingTime = findQueueSpanByJobName(spans, 'job2')
    const step2_1 = findSpanByName(spans, 'step2_1')
    const step2_2 = findSpanByName(spans, 'step2_2')
    const step2_3 = findSpanByName(spans, 'step2_3')
    expect(rootSpan.status.code).toBe(SpanStatusCode.ERROR)
    expect(job1.status.code).toBe(SpanStatusCode.OK)
    expect(job2.status.code).toBe(SpanStatusCode.ERROR)
    expect(job2WithWaitingTime.status.code).toBe(SpanStatusCode.ERROR)
    expect(job2WaitingTime.status.code).toBe(SpanStatusCode.OK)
    expect(step2_1.status.code).toBe(SpanStatusCode.OK)
    expect(step2_2.status.code).toBe(SpanStatusCode.OK)
    expect(step2_3.status.code).toBe(SpanStatusCode.ERROR)
  })

  test('should verify span hierarchy', async () => {
    const traceId = await createTrace(workflowRunResults)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/) // OpenTelemetry trace ID format
    await forceFlush()

    const spans = exporter.getFinishedSpans()

    if (!workflowRun.name) fail()
    const rootSpan = findSpanByName(spans, workflowRun.name)
    const child1 = findSpanByName(
      spans,
      `${workflowRunJobs[0].name} with time of waiting runner`
    )
    const child1_1 = findQueueSpanByJobName(spans, workflowRunJobs[0].name)
    const child1_2 = findSpanByName(spans, 'job1')
    const child1_2_1 = findSpanByName(spans, 'step1_1')
    const child1_2_2 = findSpanByName(spans, 'step1_2')
    const child1_2_3 = findSpanByName(spans, 'step1_3')
    const child2 = findSpanByName(spans, 'job2 with time of waiting runner')
    const child2_1 = findQueueSpanByJobName(spans, 'job2')
    const child2_2 = findSpanByName(spans, 'job2')
    const child2_2_1 = findSpanByName(spans, 'step2_1')
    const child2_2_2 = findSpanByName(spans, 'step2_2')
    const child2_2_3 = findSpanByName(spans, 'step2_3')

    const assertionCount =
      [
        assertParentChildRelationship(rootSpan, child1),
        assertParentChildRelationship(child1, child1_1),
        assertParentChildRelationship(child1, child1_2),
        assertParentChildRelationship(child1_2, child1_2_1),
        assertParentChildRelationship(child1_2, child1_2_2),
        assertParentChildRelationship(child1_2, child1_2_3),
        assertParentChildRelationship(rootSpan, child2),
        assertParentChildRelationship(child2, child2_1),
        assertParentChildRelationship(child2, child2_2),
        assertParentChildRelationship(child2_2, child2_2_1),
        assertParentChildRelationship(child2_2, child2_2_2),
        assertParentChildRelationship(child2_2, child2_2_3)
      ].length + 1 // add 1 because rootSpan assertion is not existed.

    expect(spans).toHaveLength(assertionCount)
  })

  test('should verify span attributes and span.type layer separation without double counting', async () => {
    await createTrace(workflowRunResults)
    await forceFlush()

    const spans = exporter.getFinishedSpans()

    const rootSpan = findSpanByName(spans, workflowRun.name)
    expect(rootSpan.attributes).toEqual({
      repository: 'test-owner/test-repo',
      run_id: 10000000000,
      run_attempt: 14,
      url: 'http://example.com/workflow_run',
      'cicd.pipeline.task.run.id': 10000000000,
      'cicd.pipeline.name': 'Test Run',
      'cicd.pipeline.run.url.full': 'http://example.com/workflow_run',
      'span.type': 'workflow',
      'workflow.conclusion': 'failure',
      'workflow.event': 'push',
      'workflow.is_retry': true,
      'workflow.wall_clock_duration_s': 1200,
      'workflow.execution_duration_s': 600,
      'workflow.queued_duration_s': 360,
      'workflow.max_queued_duration_s': 180,
      'workflow.raw_billable_minutes': 10,
      'workflow.billable_minutes': 55,
      'workflow.rounding_waste_s': 0,
      'workflow.jobs_count': 2
    })

    const job1Wrapper = findSpanByName(
      spans,
      'job1 with time of waiting runner'
    )
    expect(job1Wrapper.attributes).toEqual({
      'span.type': 'job.wrapper',
      'job.id': 30000000000,
      'job.name': 'job1'
    })

    const job1Queue = findQueueSpanByJobName(spans, 'job1')
    expect(job1Queue.attributes).toEqual({
      'span.type': 'queue',
      'job.id': 30000000000,
      'job.name': 'job1',
      'job.labels': ['ubuntu-latest'],
      'job.queued_duration_s': 180,
      'runner.runs_on': 'ubuntu-latest',
      'runner.os': 'linux',
      'runner.arch': 'amd64'
    })

    const job2Span = findSpanByName(spans, 'job2')
    expect(job2Span.attributes).toEqual({
      'span.type': 'job',
      'job.id': 30000000001,
      'job.name': 'job2',
      'job.conclusion': 'failure',
      'job.labels': ['macos-14'],
      'runner.runs_on': 'macos-14',
      'runner.os': 'macos',
      'runner.arch': 'arm64',
      'job.queued_duration_s': 180,
      'job.execution_duration_s': 300,
      'job.raw_billable_minutes': 5,
      'job.billable_minutes': 50,
      'job.billable_multiplier': 10,
      'job.rounding_waste_s': 0,
      'job.steps_count': 3
    })

    const step1Span = findSpanByName(spans, 'step1_1')
    expect(step1Span.attributes).toEqual({
      'span.type': 'step',
      'job.name': 'job1',
      'step.name': 'step1_1',
      'step.conclusion': 'success',
      'step.number': 1
    })

    // Ensure only actual job execution spans carry job.conclusion
    const spansWithJobConclusion = spans.filter(
      s => s.attributes['job.conclusion'] !== undefined
    )
    expect(spansWithJobConclusion).toHaveLength(2)
  })

  test('should capture and return valid trace ID as string', async () => {
    const traceId = await createTrace(workflowRunResults)
    await forceFlush()

    // Verify trace ID is properly extracted as string
    expect(typeof traceId).toBe('string')
    expect(traceId).toMatch(/^[0-9a-f]{32}$/) // OpenTelemetry trace ID format

    // Verify the trace ID matches the actual span trace ID
    const spans = exporter.getFinishedSpans()
    const rootSpan = findSpanByName(spans, workflowRun.name)
    expect(traceId).toBe(rootSpan.spanContext().traceId)
  })

  test('should return empty string when trace feature is disabled', async () => {
    settings.FeatureFlagTrace = false
    const traceId = await createTrace(workflowRunResults)
    await forceFlush()

    expect(traceId).toBe('')
    expect(exporter.getFinishedSpans()).toHaveLength(0)

    // Reset for other tests
    settings.FeatureFlagTrace = true
  })

  test('should return empty string when trace creation fails with invalid data', async () => {
    // Create invalid workflow results that will cause an error
    const invalidResults = {
      workflow: null,
      workflowJobs: []
    } as unknown as WorkflowResults

    const traceId = await createTrace(invalidResults)
    expect(traceId).toBe('')
  })

  test('should handle missing trace context gracefully', async () => {
    // This test verifies behavior when OpenTelemetry context is not properly set up
    // We'll temporarily disable and re-enable to simulate this scenario
    opentelemetryAllDisable()

    const traceId = await createTrace(workflowRunResults)
    // When OpenTelemetry is disabled, it returns a trace ID of all zeros
    expect(traceId).toBe('00000000000000000000000000000000')
    expect(typeof traceId).toBe('string')
  })

  test('should handle errors in trace creation and return empty string', async () => {
    // Create invalid workflow results that will cause an error in createWorkflowTrace
    const invalidResults = {
      workflow: {
        created_at: 'invalid-date', // This will cause an error
        id: 10000000000,
        name: 'Test Run',
        run_attempt: 14,
        repository: {
          full_name: 'test-owner/test-repo'
        },
        conclusion: 'failure',
        html_url: 'http://example.com/workflow_run'
      },
      workflowJobs: []
    } as unknown as WorkflowResults

    const traceId = await createTrace(invalidResults)

    // Should return empty string when error occurs
    expect(traceId).toBe('')
  })
})

const toEpochSec = (date: Date): number => {
  return Math.floor(date.getTime() / 1000)
}

const findSpanByName = (spans: ReadableSpan[], name: string): ReadableSpan => {
  const span = spans.find(s => s.name === name)
  if (!span) throw new Error(`${name} is not find in spans.`)
  return span
}

const findQueueSpanByJobName = (
  spans: ReadableSpan[],
  jobName: string
): ReadableSpan => {
  const span = spans.find(
    s => s.name === 'job.queue' && s.attributes['job.name'] === jobName
  )
  if (!span) throw new Error(`job.queue for ${jobName} is not find in spans.`)
  return span
}

const assertParentChildRelationship = (
  parent: ReadableSpan,
  child: ReadableSpan
): void => {
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
  expect(child.spanContext().traceId).toBe(parent.spanContext().traceId)
}
