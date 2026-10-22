export const descriptorNames = {
  WORKFLOW_RUNS: 'github.workflow.runs',
  WORKFLOW_DURATION: 'github.workflow.duration',
  WORKFLOW_EXECUTION_DURATION: 'github.workflow.execution_duration',
  WORKFLOW_BILLABLE_TIME: 'github.workflow.billable_time',
  WORKFLOW_ROUNDING_WASTE: 'github.workflow.rounding_waste',
  JOB_RUNS: 'github.job.runs',
  JOB_DURATION: 'github.job.duration',
  JOB_QUEUED_DURATION: 'github.job.queued_duration',
  JOB_BILLABLE_TIME: 'github.job.billable_time',
  JOB_RAW_BILLABLE_TIME: 'github.job.raw_billable_time',
  JOB_ROUNDING_WASTE: 'github.job.rounding_waste'
} as const satisfies Record<string, string>

export const attributeKeys = {
  REPOSITORY: 'repository',
  WORKFLOW_NAME: 'workflow.name',
  WORKFLOW_CONCLUSION: 'workflow.conclusion',
  WORKFLOW_EVENT: 'workflow.event',
  WORKFLOW_IS_RETRY: 'workflow.is_retry',
  WORKFLOW_RUN_ATTEMPT: 'workflow.run_attempt',
  JOB_NAME: 'job.name',
  JOB_CONCLUSION: 'job.conclusion',
  JOB_RUN_ATTEMPT: 'job.run_attempt',
  RUNNER_GROUP: 'runner.group',
  RUNNER_RUNS_ON: 'runner.runs_on',
  RUNNER_OS: 'runner.os',
  RUNNER_ARCH: 'runner.arch'
} as const satisfies Record<string, string>
