import { Octokit } from '@octokit/rest'
import { ApplicationSettings } from '../settings.js'
import {
  WorkflowContext,
  WorkflowResults,
  GitHubContext,
  WorkflowJob,
  Workflow,
  WorkflowJobs,
  toWorkflowRun as toWorkflow,
  toWorkflowJob,
  WorkflowResponse,
  WorkflowJobsResponse
} from './types.js'
import * as core from '@actions/core'
import { isTooManyTries, retryAsync } from 'ts-retry'
import { WorkflowRunEvent } from '@octokit/webhooks-types'

export const createOctokitClient = (): Octokit => {
  // process.env.GITHUB_TOKEN is used for GitHub Enterprise Server.
  const token = core.getInput('GITHUB_TOKEN') || process.env.GITHUB_TOKEN
  return new Octokit({
    baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    auth: token
  })
}

export const fetchWorkflowResults = async (
  octokit: Octokit,
  workflowContext: WorkflowContext,
  delayMs = 1000,
  maxTry = 10
): Promise<WorkflowResults> => {
  try {
    // A workflow sometime has not completed in spite of trigger of workflow completed event.
    // FYI: https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_run
    const results = await retryAsync(
      async () => {
        const workflowRes = await fetchWorkflow(octokit, workflowContext)
        const workflowJobsRes = await fetchWorkflowJobs(
          octokit,
          workflowContext
        )
        const attemptWorkflowJobs = selectJobsForAttempt(
          workflowJobsRes,
          workflowContext.attempt_number
        )
        const workflowJobs = attemptWorkflowJobs
          .map(job => toWorkflowJob(job, workflowRes.event))
          .filter((job): job is WorkflowJob => job !== null)
        if (workflowJobs.length === 0) {
          throw new Error(`no completed jobs found for workflow run.`)
        }
        const workflow = toWorkflow(workflowRes)
        const attemptStartedAt = getWorkflowAttemptStartedAt(
          workflow,
          workflowJobs
        )
        // GitHub can label reused jobs as part of a rerun while retaining their previous start times.
        const jobsRunInAttempt = workflowJobs.filter(
          job => job.started_at.getTime() >= attemptStartedAt.getTime()
        )
        if (jobsRunInAttempt.length === 0) {
          throw new Error(`no completed jobs found for workflow run.`)
        }
        return {
          workflow,
          workflowJobs: jobsRunInAttempt
        }
      },
      {
        delay: delayMs,
        maxTry,
        onError: (err, currentTry) => {
          console.error(`current try: ${currentTry}`, err)
          return undefined
        }
      }
    )
    return results
  } catch (err) {
    core.error('failed to get results of workflow run')
    if (isTooManyTries(err)) console.error('retry count exceeded maxTry')
    console.error(err)
    throw err
  }
}

const fetchWorkflow = async (
  octokit: Octokit,
  workflowContext: WorkflowContext
): Promise<WorkflowResponse> => {
  const res = await octokit.rest.actions.getWorkflowRunAttempt({
    owner: workflowContext.owner,
    repo: workflowContext.repo,
    run_id: workflowContext.runId,
    attempt_number: workflowContext.attempt_number
  })
  return {
    ...res.data
  }
}

const fetchWorkflowJobs = async (
  octokit: Octokit,
  workflowContext: WorkflowContext
): Promise<WorkflowJobsResponse> => {
  const workflowJobs: WorkflowJobsResponse = []
  let page = 1

  while (true) {
    const res = await octokit.rest.actions.listJobsForWorkflowRun({
      owner: workflowContext.owner,
      repo: workflowContext.repo,
      run_id: workflowContext.runId,
      filter: 'all',
      per_page: 100,
      page
    })
    workflowJobs.push(...res.data.jobs)
    if (workflowJobs.length >= res.data.total_count) {
      return workflowJobs
    }
    if (res.data.jobs.length === 0) {
      throw new Error('GitHub returned no jobs before all workflow jobs loaded')
    }
    page++
  }
}

const selectJobsForAttempt = (
  workflowJobs: WorkflowJobsResponse,
  targetAttemptNumber: number
): WorkflowJobsResponse =>
  workflowJobs.filter(job => (job.run_attempt ?? 1) === targetAttemptNumber)

export const getWorkflowContext = (
  context: GitHubContext,
  settings: ApplicationSettings
): WorkflowContext => {
  const owner = settings.owner ?? context.repo.owner
  const repo = settings.repository ?? context.repo.repo

  if (context.eventName !== 'workflow_run')
    return {
      owner,
      repo,
      attempt_number: context.runAttempt || 1, // 1 is for testing.
      runId: settings.workflowRunId ?? context.runId
    }

  // If this workflow is trigged on `workflow_run`, set runId targeted workflow's id.
  // Detail of `workflow_run` event: https://docs.github.com/ja/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_run
  const workflowRunEvent = context.payload as WorkflowRunEvent
  return {
    owner,
    repo,
    attempt_number: workflowRunEvent.workflow_run.run_attempt || 1, // 1 is for testing.
    runId: settings.workflowRunId ?? workflowRunEvent.workflow_run.id
  }
}

export const getLatestCompletedAt = (jobs: WorkflowJob[]): Date => {
  if (jobs.length === 0)
    throw new Error('no jobs found to get latest completed_at date.')
  const jobCompletedAtDates = jobs.map(job => job.completed_at)
  const maxDateNumber = Math.max(...jobCompletedAtDates.map(Number))
  return new Date(maxDateNumber)
}

export const getWorkflowAttemptStartedAt = (
  workflow: Workflow,
  jobs: WorkflowJobs
): Date => {
  if (
    workflow.run_started_at &&
    Number.isFinite(workflow.run_started_at.getTime())
  ) {
    return workflow.run_started_at
  }

  if (workflow.run_attempt > 1) {
    throw new Error(
      `workflow run_started_at is required for attempt ${workflow.run_attempt}.`
    )
  }

  const jobCreatedAtNumbers = jobs
    .map(job => job.created_at.getTime())
    .filter(Number.isFinite)
  if (jobCreatedAtNumbers.length === 0) {
    throw new Error(
      'no valid job created_at dates found to get workflow attempt start time.'
    )
  }

  core.notice(
    'Workflow run_started_at is unavailable; using the earliest job created_at for attempt duration.'
  )
  return new Date(Math.min(...jobCreatedAtNumbers))
}
