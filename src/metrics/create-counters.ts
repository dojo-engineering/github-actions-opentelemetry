import * as opentelemetry from '@opentelemetry/api'
import {
  getLatestCompletedAt,
  getWorkflowAttemptStartedAt,
  WorkflowRun,
  WorkflowJob,
  WorkflowJobs
} from '../github/index.js'
import { calcDiffSec } from '../utils/calc-diff-sec.js'
import { calcJobBillable, BillableMetrics } from '../utils/calc-billable.js'
import { descriptorNames as dn, attributeKeys as ak } from './constants.js'
import * as core from '@actions/core'

export const createCounter = (
  name: string,
  value: number,
  attributes: opentelemetry.Attributes,
  option?: opentelemetry.MetricOptions
): void => {
  const meter = opentelemetry.metrics.getMeter('github-actions-metrics')

  const counter = meter.createCounter(name, option)
  counter.add(value, attributes)
}

const createMetricsAttributes = (
  workflow: WorkflowRun,
  job?: WorkflowJob,
  billable?: BillableMetrics
): opentelemetry.Attributes => ({
  [ak.WORKFLOW_NAME]: workflow.name,
  [ak.REPOSITORY]: workflow.repository.full_name,
  ...(workflow.conclusion && { [ak.WORKFLOW_CONCLUSION]: workflow.conclusion }),
  ...(workflow.event && { [ak.WORKFLOW_EVENT]: workflow.event }),
  [ak.WORKFLOW_IS_RETRY]: workflow.run_attempt > 1 ? 'true' : 'false',
  [ak.WORKFLOW_RUN_ATTEMPT]: workflow.run_attempt,
  ...(job && { [ak.JOB_NAME]: job.name }),
  ...(job &&
    job.run_attempt !== undefined && {
      [ak.JOB_RUN_ATTEMPT]: job.run_attempt
    }),
  ...(job && job.conclusion && { [ak.JOB_CONCLUSION]: job.conclusion }), // conclusion specification: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks#check-statuses-and-conclusions
  ...(job &&
    job.runner_group_name && { [ak.RUNNER_GROUP]: job.runner_group_name }),
  ...(billable && billable.runsOn && { [ak.RUNNER_RUNS_ON]: billable.runsOn }),
  ...(billable && { [ak.RUNNER_OS]: billable.runnerOs }),
  ...(billable && { [ak.RUNNER_ARCH]: billable.runnerArch }),
  [ak.WORKFLOW_RUN_ID]: workflow.id
})

export const createWorkflowCounters = (
  workflow: WorkflowRun,
  workflowRunJobs: WorkflowJobs
): void => {
  const workflowMetricsAttributes = createMetricsAttributes(workflow)
  // workflow run context has no end time, so use the latest job's completed_at
  const jobCompletedAtMax = getLatestCompletedAt(workflowRunJobs)
  const attemptStartedAt = getWorkflowAttemptStartedAt(
    workflow,
    workflowRunJobs
  )

  let totalExecutionDurationSec = 0
  let totalBillableMinutes = 0
  let totalRoundingWasteSec = 0

  for (const job of workflowRunJobs) {
    const jobDurationSec = Math.max(
      0,
      calcDiffSec(job.started_at, job.completed_at)
    )
    const billable = calcJobBillable(jobDurationSec, job.conclusion, job.labels)
    totalExecutionDurationSec += jobDurationSec
    totalBillableMinutes += billable.billableMinutes
    totalRoundingWasteSec += billable.roundingWasteSec
  }

  createCounter(dn.WORKFLOW_RUNS, 1, workflowMetricsAttributes, {
    unit: '{run}'
  })
  createCounter(
    dn.WORKFLOW_DURATION,
    Math.max(0, calcDiffSec(attemptStartedAt, jobCompletedAtMax)),
    workflowMetricsAttributes,
    { unit: 's' }
  )
  createCounter(
    dn.WORKFLOW_EXECUTION_DURATION,
    totalExecutionDurationSec,
    workflowMetricsAttributes,
    { unit: 's' }
  )
  createCounter(
    dn.WORKFLOW_BILLABLE_TIME,
    totalBillableMinutes,
    workflowMetricsAttributes,
    { unit: 'min' }
  )
  createCounter(
    dn.WORKFLOW_ROUNDING_WASTE,
    totalRoundingWasteSec,
    workflowMetricsAttributes,
    { unit: 's' }
  )
}

export const createJobCounters = (
  workflow: WorkflowRun,
  workflowRunJobs: WorkflowJobs
): void => {
  for (const job of workflowRunJobs) {
    const jobDurationSec = Math.max(
      0,
      calcDiffSec(job.started_at, job.completed_at)
    )
    const billable = calcJobBillable(jobDurationSec, job.conclusion, job.labels)
    const jobMetricsAttributes = createMetricsAttributes(
      workflow,
      job,
      billable
    )

    createCounter(dn.JOB_RUNS, 1, jobMetricsAttributes, { unit: '{job}' })
    createCounter(dn.JOB_DURATION, jobDurationSec, jobMetricsAttributes, {
      unit: 's'
    })
    createCounter(
      dn.JOB_BILLABLE_TIME,
      billable.billableMinutes,
      jobMetricsAttributes,
      { unit: 'min' }
    )
    createCounter(
      dn.JOB_RAW_BILLABLE_TIME,
      billable.rawBillableMinutes,
      jobMetricsAttributes,
      { unit: 'min' }
    )
    createCounter(
      dn.JOB_ROUNDING_WASTE,
      billable.roundingWasteSec,
      jobMetricsAttributes,
      { unit: 's' }
    )

    // The calculation method for GitHub's queue times has not been disclosed.
    // Since it is displayed in the job column, it is assumed to be calculated based on job information.
    // See. https://docs.github.com/en/actions/administering-github-actions/viewing-github-actions-metrics
    const jobQueuedDuration = calcDiffSec(job.created_at, job.started_at)
    if (jobQueuedDuration < 0) {
      core.notice(
        `${job.name}: Skip to create ${dn.JOB_QUEUED_DURATION} metrics. This is a GitHub specification issue that occasionally occurs, so it can't be recover.`
      )
      continue
    }
    createCounter(
      dn.JOB_QUEUED_DURATION,
      jobQueuedDuration,
      jobMetricsAttributes,
      { unit: 's' }
    )
  }
}
