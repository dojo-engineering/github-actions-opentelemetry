import { describe, test, expect, vi } from 'vitest'
import * as opentelemetry from '@opentelemetry/api'
import {
  createCounter,
  createJobCounters,
  createWorkflowCounters
} from './create-counters.js'
import {
  InMemoryMetricExporter,
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'
import { WorkflowRun, WorkflowJob } from '../github/index.js'
import { attributeKeys as ak } from './constants.js'

interface InMemoryProvider {
  provider: MeterProvider
  exporter: InMemoryMetricExporter
}

const createMeterProvider = (
  aggregationTemporality = AggregationTemporality.DELTA
): InMemoryProvider => {
  const exporter = new InMemoryMetricExporter(aggregationTemporality)
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter
      })
    ]
  })
  return { provider, exporter }
}

describe('createCounter', () => {
  test('should create a counter and add the value', async () => {
    const { provider, exporter } = createMeterProvider()
    const mockGetMeter = vi
      .spyOn(opentelemetry.metrics, 'getMeter')
      .mockImplementation(name => provider.getMeter(name))
    const attributes = { test1: 'test1', test2: 'test2' }

    createCounter('testCounter', 42, attributes)

    await provider.forceFlush()
    await provider.shutdown()

    expect(mockGetMeter).toHaveBeenCalledOnce()
    expect(exporter.getMetrics()).toMatchObject([
      {
        scopeMetrics: [
          {
            scope: {
              version: '',
              schemaUrl: undefined
            },
            metrics: [
              {
                descriptor: {
                  name: 'testCounter',
                  type: 'COUNTER',
                  description: '',
                  unit: '',
                  valueType: 1,
                  advice: {}
                },
                aggregationTemporality: 0,
                dataPointType: 3,
                dataPoints: [
                  {
                    attributes: { test1: 'test1', test2: 'test2' },
                    value: 42
                  }
                ]
              }
            ]
          }
        ]
      }
    ])

    mockGetMeter.mockRestore()
  })
})

describe('createJobCounters', () => {
  const mockWorkflow: WorkflowRun = {
    id: 123,
    name: 'Test Workflow',
    conclusion: 'success',
    created_at: new Date('2023-01-01T00:00:00Z'),
    run_started_at: new Date('2023-01-01T00:00:00Z'),
    run_attempt: 1,
    html_url: 'https://github.com/test/repo/actions/runs/123',
    repository: {
      full_name: 'test-owner/test-repo'
    }
  }

  test('should skip creating JOB_QUEUED_DURATION metric when jobQueuedDuration is negative', async () => {
    const { provider, exporter } = createMeterProvider()
    const mockGetMeter = vi
      .spyOn(opentelemetry.metrics, 'getMeter')
      .mockImplementation(name => provider.getMeter(name))

    // Create a job where started_at is before created_at, causing negative duration
    const jobWithNegativeDuration: WorkflowJob = {
      id: 456,
      name: 'Test Job',
      status: 'completed',
      conclusion: 'success',
      created_at: new Date('2023-01-01T00:05:00Z'), // Later time
      started_at: new Date('2023-01-01T00:01:00Z'), // Earlier time - causes negative duration
      completed_at: new Date('2023-01-01T00:10:00Z'),
      workflow_name: 'Test Workflow',
      run_id: 123,
      runner_name: null,
      runner_group_name: null,
      steps: []
    }

    createJobCounters(mockWorkflow, [jobWithNegativeDuration])
    await provider.forceFlush()
    await provider.shutdown()

    const metricNames = exporter
      .getMetrics()[0]
      .scopeMetrics[0].metrics.map(m => m.descriptor.name)
    expect(metricNames).not.toContain('github.job.queued_duration')
    expect(metricNames).toContain('github.job.duration')

    mockGetMeter.mockRestore()
  })

  test('should clamp negative job and workflow durations to zero', async () => {
    const { provider, exporter } = createMeterProvider()
    const mockGetMeter = vi
      .spyOn(opentelemetry.metrics, 'getMeter')
      .mockImplementation(name => provider.getMeter(name))
    const jobWithNegativeDuration: WorkflowJob = {
      id: 789,
      name: 'Negative Duration Job',
      status: 'completed',
      conclusion: 'success',
      created_at: new Date('2023-01-01T00:00:00Z'),
      started_at: new Date('2023-01-01T00:05:00Z'),
      completed_at: new Date('2023-01-01T00:04:00Z'),
      workflow_name: 'Test Workflow',
      run_id: 123,
      runner_name: null,
      runner_group_name: null,
      steps: []
    }
    const workflowWithNegativeDuration: WorkflowRun = {
      ...mockWorkflow,
      run_started_at: new Date('2023-01-01T00:06:00Z')
    }

    createJobCounters(workflowWithNegativeDuration, [jobWithNegativeDuration])
    createWorkflowCounters(workflowWithNegativeDuration, [
      jobWithNegativeDuration
    ])
    await provider.forceFlush()
    await provider.shutdown()

    const metrics = exporter.getMetrics()[0].scopeMetrics[0].metrics
    const jobDuration = metrics.find(
      metric => metric.descriptor.name === 'github.job.duration'
    )
    const workflowDuration = metrics.find(
      metric => metric.descriptor.name === 'github.workflow.duration'
    )

    expect(jobDuration?.dataPoints.map(point => point.value)).toEqual([0])
    expect(workflowDuration?.dataPoints.map(point => point.value)).toEqual([0])

    mockGetMeter.mockRestore()
  })

  test('should retain self-hosted execution metrics and runner attributes without hosted billing', async () => {
    const { provider, exporter } = createMeterProvider()
    const mockGetMeter = vi
      .spyOn(opentelemetry.metrics, 'getMeter')
      .mockImplementation(name => provider.getMeter(name))
    const selfHostedJob: WorkflowJob = {
      id: 456,
      name: 'Self-hosted Job',
      status: 'completed',
      conclusion: 'success',
      created_at: new Date('2023-01-01T00:00:00Z'),
      started_at: new Date('2023-01-01T00:01:00Z'),
      completed_at: new Date('2023-01-01T00:02:01Z'),
      workflow_name: 'Test Workflow',
      run_id: 123,
      runner_name: null,
      runner_group_name: null,
      labels: ['self-hosted', 'windows-2022', 'x64'],
      steps: []
    }

    createJobCounters(mockWorkflow, [selfHostedJob])
    await provider.forceFlush()
    await provider.shutdown()

    const metrics = exporter.getMetrics()[0].scopeMetrics[0].metrics
    const jobDuration = metrics.find(
      metric => metric.descriptor.name === 'github.job.duration'
    )
    const billableTime = metrics.find(
      metric => metric.descriptor.name === 'github.job.billable_time'
    )
    const rawBillableTime = metrics.find(
      metric => metric.descriptor.name === 'github.job.raw_billable_time'
    )
    const roundingWaste = metrics.find(
      metric => metric.descriptor.name === 'github.job.rounding_waste'
    )

    expect(jobDuration?.dataPoints[0]?.value).toBe(61)
    expect(jobDuration?.dataPoints[0]?.attributes).toMatchObject({
      [ak.RUNNER_OS]: 'windows',
      [ak.RUNNER_ARCH]: 'amd64',
      [ak.RUNNER_RUNS_ON]: 'self-hosted,windows-2022,x64'
    })
    expect(billableTime?.dataPoints[0]?.value).toBe(0)
    expect(rawBillableTime?.dataPoints[0]?.value).toBe(0)
    expect(roundingWaste?.dataPoints[0]?.value).toBe(0)

    mockGetMeter.mockRestore()
  })

  test('should isolate cumulative metrics from independent workflow runs', async () => {
    const job: WorkflowJob = {
      id: 456,
      name: 'Test Job',
      status: 'completed',
      conclusion: 'success',
      created_at: new Date('2023-01-01T00:00:00Z'),
      started_at: new Date('2023-01-01T00:01:00Z'),
      completed_at: new Date('2023-01-01T00:02:00Z'),
      workflow_name: 'Test Workflow',
      run_id: 123,
      runner_name: null,
      runner_group_name: null,
      labels: ['ubuntu-latest'],
      steps: []
    }
    const exporters: InMemoryMetricExporter[] = []

    for (const runId of [123, 124]) {
      const { provider, exporter } = createMeterProvider(
        AggregationTemporality.CUMULATIVE
      )
      const mockGetMeter = vi
        .spyOn(opentelemetry.metrics, 'getMeter')
        .mockImplementation(name => provider.getMeter(name))
      const workflow = { ...mockWorkflow, id: runId }
      const workflowJob = { ...job, run_id: runId }

      createWorkflowCounters(workflow, [workflowJob])
      createJobCounters(workflow, [workflowJob])
      await provider.forceFlush()
      await provider.shutdown()
      mockGetMeter.mockRestore()
      exporters.push(exporter)
    }

    const workflowRunPoints = exporters.map(exporter => {
      const metric = exporter
        .getMetrics()[0]
        .scopeMetrics[0].metrics.find(
          item => item.descriptor.name === 'github.workflow.runs'
        )
      const point = metric?.dataPoints[0]
      if (!metric || !point) {
        throw new Error('Expected a github.workflow.runs data point')
      }
      expect(metric.aggregationTemporality).toBe(
        AggregationTemporality.CUMULATIVE
      )
      return point
    })

    expect(workflowRunPoints.map(point => point.attributes)).toMatchObject([
      {
        [ak.WORKFLOW_NAME]: 'Test Workflow',
        [ak.WORKFLOW_RUN_ID]: 123,
        [ak.WORKFLOW_RUN_ATTEMPT]: 1
      },
      {
        [ak.WORKFLOW_NAME]: 'Test Workflow',
        [ak.WORKFLOW_RUN_ID]: 124,
        [ak.WORKFLOW_RUN_ATTEMPT]: 1
      }
    ])
    expect(
      workflowRunPoints.reduce((total, point) => total + Number(point.value), 0)
    ).toBe(2)

    const jobBillablePoints = exporters.map(exporter => {
      const metric = exporter
        .getMetrics()[0]
        .scopeMetrics[0].metrics.find(
          item => item.descriptor.name === 'github.job.billable_time'
        )
      const point = metric?.dataPoints[0]
      if (!point) {
        throw new Error('Expected a github.job.billable_time data point')
      }
      return point
    })
    expect(
      jobBillablePoints.map(point => point.attributes[ak.WORKFLOW_RUN_ID])
    ).toEqual([123, 124])
  })
})
