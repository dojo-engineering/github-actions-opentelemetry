import { Context, ROOT_CONTEXT } from '@opentelemetry/api'
import {
  WorkflowJob,
  WorkflowJobs,
  getLatestCompletedAt,
  getWorkflowAttemptStartedAt
} from '../github/index.js'
import * as opentelemetry from '@opentelemetry/api'
import { calcDiffSec } from '../utils/calc-diff-sec.js'
import { calcJobBillable } from '../utils/calc-billable.js'
import * as core from '@actions/core'
import { Workflow, WorkflowStep } from '../github/types.js'

export const createWorkflowTrace = (
  workflow: Workflow,
  workflowJobs: WorkflowJobs
): Context => {
  const latestCompletedAt = getLatestCompletedAt(workflowJobs)
  const attemptStartedAt = getWorkflowAttemptStartedAt(workflow, workflowJobs)
  const span = createSpan(
    ROOT_CONTEXT,
    workflow.name,
    attemptStartedAt,
    latestCompletedAt,
    workflow.conclusion || '', // '' is converted to UNSET status. we should not use ''.
    {
      ...buildWorkflowAttributes(
        workflow,
        workflowJobs,
        latestCompletedAt,
        attemptStartedAt
      )
    }
  )

  return opentelemetry.trace.setSpan(ROOT_CONTEXT, span)
}

export const createWorkflowJobSpan = (
  ctx: Context,
  job: WorkflowJob
): Context => {
  if (!job.completed_at) {
    throw new Error(
      `Job completed_at is required for span creation: ${job.name} (id: ${job.id})`
    )
  }

  const spanWithWaiting = createSpan(
    ctx,
    `${job.name} with time of waiting runner`,
    job.created_at,
    job.completed_at,
    job.conclusion,
    { ...buildJobWrapperAttributes(job) }
  )
  const ctxWithWaiting = opentelemetry.trace.setSpan(ctx, spanWithWaiting)

  const waitingSpanName = 'job.queue'
  const jobQueuedDuration = calcDiffSec(job.created_at, job.started_at)
  if (jobQueuedDuration >= 0) {
    createSpan(
      ctxWithWaiting,
      waitingSpanName,
      job.created_at,
      job.started_at,
      'success', // waiting runner is not a error.
      { ...buildJobQueueAttributes(job, jobQueuedDuration) }
    )
  } else {
    core.notice(
      `${job.name}: Skip to create "${waitingSpanName}" span. This is a GitHub specification issue that occasionally occurs, so it can't be recover.`
    )
  }

  const jobSpan = createSpan(
    ctxWithWaiting,
    job.name,
    job.started_at,
    job.completed_at,
    job.conclusion,
    { ...buildWorkflowJobAttributes(job, job.completed_at, jobQueuedDuration) }
  )

  return opentelemetry.trace.setSpan(ctxWithWaiting, jobSpan)
}

export const createWorkflowRunStepSpan = (
  ctx: Context,
  job: WorkflowJob
): void => {
  job.steps.forEach(step => {
    if (step.started_at == null || step.completed_at == null) {
      console.warn(
        `Step ${step.name} in job ${job.name} has null timestamps, skipping span creation`
      )
      return
    }
    createSpan(
      ctx,
      step.name,
      step.started_at,
      step.completed_at,
      step.conclusion,
      { ...buildWorkflowStepAttributes(job, step) }
    )
  })
}

const createSpan = (
  ctx: Context,
  name: string,
  startAt: Date,
  endAt: Date,
  // TODO: use user defined type instead of string
  conclusion: string,
  attributes: opentelemetry.Attributes
): opentelemetry.Span => {
  const tracer = opentelemetry.trace.getTracer('github-actions-opentelemetry')
  const span = tracer.startSpan(name, { startTime: startAt, attributes }, ctx)
  span.setStatus(getSpanStatusFromConclusion(conclusion))
  span.end(endAt)
  return span
}

// In reality, the values of `conclusion` for step, job, and workflow might differ.
// However, I couldn't find a complete definition in the official documentation.
// The type of `conclusion` for a job is defined, but for step and workflow, it is just a string.
// At the very least, we know that `conclusion` for step, job, and workflow can take the values `success` and `failure`,
// so I have summarized the definitions accordingly.
export const getSpanStatusFromConclusion = (
  status: string
): opentelemetry.SpanStatus => {
  switch (status) {
    case 'success':
      return { code: opentelemetry.SpanStatusCode.OK }
    case 'failure':
    case 'timed_out':
      return { code: opentelemetry.SpanStatusCode.ERROR }
    default:
      return { code: opentelemetry.SpanStatusCode.UNSET }
  }
}

const buildWorkflowAttributes = (
  workflowRun: Workflow,
  workflowJobs: WorkflowJobs,
  latestCompletedAt: Date,
  attemptStartedAt: Date
): opentelemetry.Attributes => {
  const wallClockDurationSec = Math.max(
    0,
    calcDiffSec(attemptStartedAt, latestCompletedAt)
  )

  let totalExecutionDurationSec = 0
  let totalQueuedDurationSec = 0
  let maxQueuedDurationSec = 0
  let totalRawBillableMinutes = 0
  let totalBillableMinutes = 0
  let totalRoundingWasteSec = 0

  for (const job of workflowJobs) {
    const queuedSec = Math.max(0, calcDiffSec(job.created_at, job.started_at))
    totalQueuedDurationSec += queuedSec
    if (queuedSec > maxQueuedDurationSec) {
      maxQueuedDurationSec = queuedSec
    }

    const execSec = job.completed_at
      ? Math.max(0, calcDiffSec(job.started_at, job.completed_at))
      : 0
    totalExecutionDurationSec += execSec

    const billable = calcJobBillable(execSec, job.conclusion, job.labels)
    totalRawBillableMinutes += billable.rawBillableMinutes
    totalBillableMinutes += billable.billableMinutes
    totalRoundingWasteSec += billable.roundingWasteSec
  }

  return {
    repository: workflowRun.repository.full_name,
    run_id: workflowRun.id,
    run_attempt: workflowRun.run_attempt,
    url: workflowRun.html_url,
    // OTEL attributes
    'cicd.pipeline.task.run.id': workflowRun.id,
    'cicd.pipeline.name': workflowRun.name,
    'cicd.pipeline.run.url.full': workflowRun.html_url,
    'span.type': 'workflow',
    'workflow.conclusion': workflowRun.conclusion || undefined,
    'workflow.event': workflowRun.event,
    'workflow.is_retry': workflowRun.run_attempt > 1,
    'workflow.wall_clock_duration_s': wallClockDurationSec,
    'workflow.execution_duration_s': totalExecutionDurationSec,
    'workflow.queued_duration_s': totalQueuedDurationSec,
    'workflow.max_queued_duration_s': maxQueuedDurationSec,
    'workflow.raw_billable_minutes': totalRawBillableMinutes,
    'workflow.billable_minutes': totalBillableMinutes,
    'workflow.rounding_waste_s': totalRoundingWasteSec,
    'workflow.jobs_count': workflowJobs.length
  }
}

const buildJobWrapperAttributes = (
  job: WorkflowJob
): opentelemetry.Attributes => ({
  'span.type': 'job.wrapper',
  'job.id': job.id,
  'job.name': job.name,
  ...(job.run_attempt !== undefined && {
    'job.run_attempt': job.run_attempt
  })
})

const buildJobQueueAttributes = (
  job: WorkflowJob,
  jobQueuedDuration: number
): opentelemetry.Attributes => {
  const billable = calcJobBillable(0, job.conclusion, job.labels)
  return {
    'span.type': 'queue',
    'job.id': job.id,
    'job.name': job.name,
    ...(job.run_attempt !== undefined && {
      'job.run_attempt': job.run_attempt
    }),
    'job.labels': job.labels ? [...job.labels] : undefined,
    'job.queued_duration_s': jobQueuedDuration,
    'runner.name': job.runner_name || undefined,
    'runner.group': job.runner_group_name || undefined,
    'runner.runs_on': billable.runsOn,
    'runner.os': billable.runnerOs,
    'runner.arch': billable.runnerArch
  }
}

const buildWorkflowJobAttributes = (
  job: WorkflowJob,
  completedAt: Date,
  jobQueuedDuration: number
): opentelemetry.Attributes => {
  const jobExecutionDuration = Math.max(
    0,
    calcDiffSec(job.started_at, completedAt)
  )
  const billable = calcJobBillable(
    jobExecutionDuration,
    job.conclusion,
    job.labels
  )

  return {
    'span.type': 'job',
    'job.id': job.id,
    'job.name': job.name,
    ...(job.run_attempt !== undefined && {
      'job.run_attempt': job.run_attempt
    }),
    'job.conclusion': job.conclusion,
    'job.labels': job.labels ? [...job.labels] : undefined,
    'runner.name': job.runner_name || undefined,
    'runner.group': job.runner_group_name || undefined,
    'runner.runs_on': billable.runsOn,
    'runner.os': billable.runnerOs,
    'runner.arch': billable.runnerArch,
    'job.queued_duration_s': Math.max(0, jobQueuedDuration),
    'job.execution_duration_s': jobExecutionDuration,
    'job.raw_billable_minutes': billable.rawBillableMinutes,
    'job.billable_minutes': billable.billableMinutes,
    'job.billable_multiplier': billable.multiplier,
    'job.rounding_waste_s': billable.roundingWasteSec,
    'job.steps_count': job.steps.length
  }
}

const buildWorkflowStepAttributes = (
  job: WorkflowJob,
  step: WorkflowStep
): opentelemetry.Attributes => ({
  'span.type': 'step',
  'job.id': job.id,
  'job.name': job.name,
  ...(job.run_attempt !== undefined && {
    'job.run_attempt': job.run_attempt
  }),
  'step.name': step.name,
  'step.conclusion': step.conclusion,
  'step.number': step.number
})
