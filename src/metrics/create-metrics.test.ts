import { describe, test, expect, afterEach, beforeEach } from 'vitest'
import { WorkflowResults } from '../github/index.js'
import {
  InMemoryMetricExporter,
  AggregationTemporality,
  DataPointType,
  MetricData
} from '@opentelemetry/sdk-metrics'
import {
  initialize,
  _forceFlushMeterProvider
} from '../instrumentation/index.js'
import { calcDiffSec } from '../utils/calc-diff-sec.js'
import { createMetrics } from './create-metrics.js'
import { opentelemetryAllDisable } from '../utils/opentelemetry-all-disable.js'
import { descriptorNames as dn, attributeKeys as ak } from './constants.js'
import { fail } from 'assert'
import settings from '../settings.js'

const workflowRunResults: WorkflowResults = {
  workflow: {
    created_at: new Date('2024-09-01T00:00:00Z'),
    id: 10000000000,
    name: 'Test Run',
    run_attempt: 14,
    run_started_at: new Date('2024-09-01T00:01:00Z'),
    conclusion: 'success',
    event: 'pull_request',
    repository: {
      full_name: 'test-owner/test-repo'
    },
    html_url: 'http://example.com/workflow_run'
  },
  workflowJobs: [
    {
      created_at: new Date('2024-09-01T00:02:00Z'),
      started_at: new Date('2024-09-01T00:05:00Z'),
      completed_at: new Date('2024-09-01T00:10:15Z'), // 315s (5m 15s) -> 6 raw min, 45s waste
      conclusion: 'success',
      run_attempt: 14,
      id: 30000000000,
      name: 'job1',
      run_id: 10000000000,
      workflow_name: 'Test Run',
      status: 'completed',
      labels: ['ubuntu-24.04-arm'],
      steps: [
        {
          name: 'step1_1',
          started_at: new Date('2024-09-01T00:05:10Z'),
          completed_at: new Date('2024-09-01T00:05:20Z'),
          conclusion: 'success'
        },
        {
          name: 'step1_2',
          started_at: new Date('2024-09-01T00:05:30Z'),
          completed_at: new Date('2024-09-01T00:05:35Z'),
          conclusion: 'success'
        },
        {
          name: 'step1_3',
          started_at: new Date('2024-09-01T00:05:40Z'),
          completed_at: new Date('2024-09-01T00:05:50Z'),
          conclusion: 'success'
        }
      ],
      runner_name: 'runner-1',
      runner_group_name: 'linux-arm-pool'
    },
    {
      created_at: new Date('2024-09-01T00:12:00Z'),
      started_at: new Date('2024-09-01T00:15:00Z'),
      completed_at: new Date('2024-09-01T00:16:10Z'), // 70s (1m 10s) -> 2 raw min, 50s waste, 20 billable min on macos
      conclusion: 'failure',
      run_attempt: 14,
      id: 30000000001,
      name: 'job2',
      run_id: 10000000000,
      workflow_name: 'Test Run',
      status: 'completed',
      labels: ['macos-14'],
      steps: [
        {
          name: 'step2_1',
          started_at: new Date('2024-09-01T00:15:10Z'),
          completed_at: new Date('2024-09-01T00:15:20Z'),
          conclusion: 'success'
        },
        {
          name: 'step2_2',
          started_at: new Date('2024-09-01T00:15:30Z'),
          completed_at: new Date('2024-09-01T00:15:35Z'),
          conclusion: 'success'
        },
        {
          name: 'step2_3',
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

describe('should export expected metrics', () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)

  beforeEach(() => {
    exporter.reset()
    initialize(exporter)
  })

  afterEach(async () => {
    opentelemetryAllDisable()
  })

  test(`should verify ${dn.WORKFLOW_RUNS} and ${dn.JOB_RUNS}`, async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()

    const workflowRunsMetric = findMetricByDescriptorName(
      exporter,
      dn.WORKFLOW_RUNS
    )
    expect(workflowRunsMetric.dataPointType).toBe(DataPointType.SUM)
    expect(workflowRunsMetric.dataPoints).toHaveLength(1)
    expect(workflowRunsMetric.dataPoints[0].value).toBe(1)
    expect(
      workflowRunsMetric.dataPoints[0].attributes[ak.WORKFLOW_RUN_ATTEMPT]
    ).toBe(workflowRun.run_attempt)

    const jobRunsMetric = findMetricByDescriptorName(exporter, dn.JOB_RUNS)
    expect(jobRunsMetric.dataPointType).toBe(DataPointType.SUM)
    expect(jobRunsMetric.dataPoints).toHaveLength(2)
    expect(jobRunsMetric.dataPoints.map(dp => dp.value)).toEqual([1, 1])
  })

  test(`should verify ${dn.JOB_DURATION} and ${dn.JOB_QUEUED_DURATION}`, async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()
    const metric = findMetricByDescriptorName(exporter, dn.JOB_DURATION)
    const dataPoints = metric.dataPoints.map(dataPoint => ({
      taskName: dataPoint.attributes[ak.JOB_NAME],
      value: dataPoint.value
    }))

    expect(dataPoints).toHaveLength(workflowRunJobs.length)
    for (const job of workflowRunJobs) {
      if (!job.completed_at) fail()
      expect(dataPoints).toContainEqual({
        taskName: job.name,
        value: calcDiffSec(job.started_at, job.completed_at)
      })
    }

    const queuedMetric = findMetricByDescriptorName(
      exporter,
      dn.JOB_QUEUED_DURATION
    )
    expect(queuedMetric.dataPoints).toHaveLength(2)
    expect(queuedMetric.dataPoints[0].value).toBe(180)
    expect(queuedMetric.dataPoints[1].value).toBe(180)
  })

  test('should verify billable time and rounding waste counters', async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()

    const jobBillable = findMetricByDescriptorName(
      exporter,
      dn.JOB_BILLABLE_TIME
    )
    const jobRawBillable = findMetricByDescriptorName(
      exporter,
      dn.JOB_RAW_BILLABLE_TIME
    )
    const jobWaste = findMetricByDescriptorName(exporter, dn.JOB_ROUNDING_WASTE)
    const wfExecDuration = findMetricByDescriptorName(
      exporter,
      dn.WORKFLOW_EXECUTION_DURATION
    )
    const wfBillable = findMetricByDescriptorName(
      exporter,
      dn.WORKFLOW_BILLABLE_TIME
    )
    const wfWaste = findMetricByDescriptorName(
      exporter,
      dn.WORKFLOW_ROUNDING_WASTE
    )

    // job1: 315s -> 6 raw min, 1x linux = 6 billable min, 45s waste
    // job2: 70s -> 2 raw min, 10x macos = 20 billable min, 50s waste
    expect(jobRawBillable.dataPoints.map(dp => dp.value)).toEqual([6, 2])
    expect(jobBillable.dataPoints.map(dp => dp.value)).toEqual([6, 20])
    expect(jobWaste.dataPoints.map(dp => dp.value)).toEqual([45, 50])

    expect(wfExecDuration.dataPoints[0].value).toBe(315 + 70)
    expect(wfBillable.dataPoints[0].value).toBe(6 + 20)
    expect(wfWaste.dataPoints[0].value).toBe(45 + 50)
  })

  test(`should verify ${dn.WORKFLOW_DURATION}`, async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()
    const metric = findMetricByDescriptorName(exporter, dn.WORKFLOW_DURATION)

    expect(metric.dataPoints).toHaveLength(1)
    if (!workflowRunJobs[1].completed_at) fail()
    expect(metric.dataPoints[0].value).toEqual(
      calcDiffSec(
        workflowRun.run_started_at ?? workflowRun.created_at,
        workflowRunJobs[1].completed_at // last job's complete_at
      )
    )
  })

  test('should not export metrics when disable FeatureFlagMetrics', async () => {
    settings.FeatureFlagMetrics = false
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()
    expect(exporter.getMetrics()).toHaveLength(0)
    settings.FeatureFlagMetrics = true
  })

  test(`should throw error when createMetrics fails`, async () => {
    const brokenResults = {} as WorkflowResults
    await expect(createMetrics(brokenResults)).rejects.toThrow()
  })
})

describe('should export expected attributes', () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)

  beforeEach(() => {
    exporter.reset()
    initialize(exporter)
  })

  afterEach(async () => {
    opentelemetryAllDisable()
  })

  test('should export workflow name, conclusion, event, and is_retry', async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()
    const metricWorkflow = findMetricByDescriptorName(
      exporter,
      dn.WORKFLOW_DURATION
    )
    const metricJob = findMetricByDescriptorName(exporter, dn.JOB_DURATION)

    expect(metricWorkflow.dataPoints).toHaveLength(1)
    expect(metricWorkflow.dataPoints[0].attributes).toMatchObject({
      [ak.WORKFLOW_NAME]: workflowRun.name,
      [ak.WORKFLOW_CONCLUSION]: 'success',
      [ak.WORKFLOW_EVENT]: 'pull_request',
      [ak.WORKFLOW_IS_RETRY]: 'true',
      [ak.WORKFLOW_RUN_ATTEMPT]: 14
    })
    expect(metricJob.dataPoints).toHaveLength(2)
    for (const point of metricJob.dataPoints) {
      expect(point.attributes[ak.WORKFLOW_NAME]).toEqual(workflowRun.name)
      expect(point.attributes[ak.WORKFLOW_IS_RETRY]).toEqual('true')
      expect(point.attributes[ak.WORKFLOW_RUN_ATTEMPT]).toEqual(14)
      expect(point.attributes[ak.JOB_RUN_ATTEMPT]).toEqual(14)
    }
  })

  test('should export workflow.is_retry as false when run_attempt is 1', async () => {
    await createMetrics({
      ...workflowRunResults,
      workflow: {
        ...workflowRunResults.workflow,
        run_attempt: 1
      }
    })
    await _forceFlushMeterProvider()
    const metricWorkflow = findMetricByDescriptorName(
      exporter,
      dn.WORKFLOW_DURATION
    )
    expect(
      metricWorkflow.dataPoints[0].attributes[ak.WORKFLOW_IS_RETRY]
    ).toEqual('false')
    expect(
      metricWorkflow.dataPoints[0].attributes[ak.WORKFLOW_RUN_ATTEMPT]
    ).toEqual(1)
  })

  test('should export repository name', async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()
    const metricWorkflow = findMetricByDescriptorName(
      exporter,
      dn.WORKFLOW_DURATION
    )
    const metricJob = findMetricByDescriptorName(exporter, dn.JOB_DURATION)

    expect(metricWorkflow.dataPoints).toHaveLength(1)
    expect(metricWorkflow.dataPoints[0].attributes[ak.REPOSITORY]).toEqual(
      workflowRun.repository.full_name
    )
    expect(metricJob.dataPoints).toHaveLength(2)
    for (const point of metricJob.dataPoints) {
      expect(point.attributes[ak.REPOSITORY]).toEqual(
        workflowRun.repository.full_name
      )
    }
  })

  test('should export job and runner attributes in job metrics', async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()
    const metric = findMetricByDescriptorName(exporter, dn.JOB_DURATION)

    expect(metric.dataPoints).toHaveLength(2)
    expect(metric.dataPoints[0].attributes).toMatchObject({
      [ak.JOB_NAME]: 'job1',
      [ak.JOB_CONCLUSION]: 'success',
      [ak.RUNNER_GROUP]: 'linux-arm-pool',
      [ak.RUNNER_RUNS_ON]: 'ubuntu-24.04-arm',
      [ak.RUNNER_OS]: 'linux',
      [ak.RUNNER_ARCH]: 'arm64'
    })
    expect(metric.dataPoints[1].attributes).toMatchObject({
      [ak.JOB_NAME]: 'job2',
      [ak.JOB_CONCLUSION]: 'failure',
      [ak.RUNNER_RUNS_ON]: 'macos-14',
      [ak.RUNNER_OS]: 'macos',
      [ak.RUNNER_ARCH]: 'arm64'
    })
    expect(metric.dataPoints[1].attributes[ak.RUNNER_GROUP]).toBeUndefined()
  })

  test('should not export job name or job conclusion in workflow metrics', async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()
    const metric = findMetricByDescriptorName(exporter, dn.WORKFLOW_DURATION)

    expect(metric.dataPoints).toHaveLength(1)
    expect(metric.dataPoints[0].attributes[ak.JOB_NAME]).toBeUndefined()
    expect(metric.dataPoints[0].attributes[ak.JOB_CONCLUSION]).toBeUndefined()
  })

  test('should verify resource attributes', async () => {
    await createMetrics(workflowRunResults)
    await _forceFlushMeterProvider()

    const metrics = exporter.getMetrics()
    expect(metrics).toHaveLength(1)

    const resourceAttributes = metrics[0].resource.attributes
    // NOTE: Resource attributes are defined in vitest.config.ts
    expect(resourceAttributes).toMatchObject({
      'service.name': 'github-actions-opentelemetry',
      'test.attribute': 'example',
      'test.attribute2': 'example2'
    })
  })
})

const findMetricByDescriptorName = (
  exporter: InMemoryMetricExporter,
  name: string
): MetricData => {
  expect(exporter.getMetrics()).toHaveLength(1)
  expect(exporter.getMetrics()[0].scopeMetrics).toHaveLength(1)
  const metric = exporter
    .getMetrics()[0]
    .scopeMetrics[0].metrics.find(v => v.descriptor.name === name)
  if (metric === undefined) {
    throw new Error(`${name} descriptor is not found`)
  }
  return metric
}
