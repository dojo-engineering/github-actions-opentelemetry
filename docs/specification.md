# GitHub Actions OpenTelemetry - Specification

## Operating Modes

The action operates in two distinct modes based on the triggering event:

## workflow_run Mode

- **Trigger**: `workflow_run` completion events
- **Target**: Processes the completed workflow specified in the event payload
- **Job Requirement**: All jobs must be completed (throws error for incomplete
  jobs)
- **Backward Compatibility**: Maintains strict completion requirements for
  existing integrations

### Current Workflow Mode

- **Trigger**: Any other GitHub event type (push, pull_request, etc.)
- **Target**: Processes the current workflow when run as final job
- **Job Filtering**: Incomplete jobs are filtered out with warning logs
- **Flexibility**: Supports in-progress workflows by collecting data from
  completed jobs only

## Data Collection Process

### GitHub API Integration

- **Authentication**: Requires `GITHUB_TOKEN` input parameter
- **API Endpoints**: Uses `getWorkflowRunAttempt` and `listJobsForWorkflowRun`
- **Retry Logic**: Implements exponential backoff (default: 1000ms delay, 10 max
  attempts)
- **Pagination**: Supports up to 100 jobs per workflow run

### Job Processing Rules

#### Completion Status Validation

- **workflow_run events**: Jobs with status ≠ 'completed' throw an error
- **Other events**: Jobs with status ≠ 'completed' are logged and skipped
- **Required Fields**: All processed jobs must have `conclusion`,
  `completed_at`, and `workflow_name`

#### Self-Exclusion & Re-run Filtering Logic

- The GitHub Actions OpenTelemetry job excludes itself from telemetry collection
- Only jobs whose `run_attempt` matches the target workflow attempt are
  included. Earlier successful jobs are not repeated for failed-job reruns; jobs
  actually rerun in a later attempt are counted again as new work.

## Metrics Specification

### Feature Control

- **Environment Variable**: `FEATURE_METRICS` (default: true)
- **Meter Name**: `github-actions-metrics`
- **Metric Type**: Counter (`meter.createCounter`)
- **Units**: Seconds (`s`), Minutes (`min`), or Count (`1`)

### Workflow Metrics

- `github.workflow.runs` (unit: `1`): Count of collected workflow attempts.
  `workflow_run` mode captures each rerun, including partial reruns; current
  workflow mode counts only attempts in which the telemetry job runs.
- `github.workflow.duration` (unit: `s`): `workflow.run_started_at` to the
  latest `job.completed_at` in that attempt (falls back to the earliest job
  `created_at` if `run_started_at` is unavailable)
- `github.workflow.billable_time` (unit: `min`): Sum of OS-multiplied billable
  minutes across jobs executed in that attempt. Summing by workflow name across
  attempts gives total billable usage, including jobs actually rerun.
- **Attributes**:
  - `workflow.name`: Workflow name
  - `repository`: Full repository name (owner/repo)
  - `workflow.conclusion`: Workflow completion status
  - `workflow.event`: Triggering GitHub event name
  - `workflow.run_attempt`: Numeric attempt number
  - `workflow.is_retry`: `'true'` if `run_attempt > 1`, else `'false'`

### Job Metrics

- `github.job.runs` (unit: `1`): Count of job runs
- `github.job.duration` (unit: `s`): `job.started_at` to `job.completed_at`
- `github.job.queued_duration` (unit: `s`): `job.created_at` to `job.started_at`
  (skipped when negative)
- `github.job.billable_time` (unit: `min`):
  `max(1, ceil(duration_s / 60)) * os_multiplier` (or `0` when skipped /
  duration <= 0)
- `github.job.rounding_waste` (unit: `s`):
  `(raw_billable_minutes * 60) - duration_s`
- **Attributes**:
  - `workflow.name`: Parent workflow name
  - `repository`: Full repository name
  - `job.name`: Job identifier
  - `job.conclusion`: Job completion status (success, failure, etc.)
  - `workflow.run_attempt`: Numeric attempt number
  - `job.run_attempt`: Numeric job attempt number
  - `runner.os`: `'linux' | 'windows' | 'macos' | 'unknown'`
  - `runner.arch`: `'arm64' | 'amd64' | 'unknown'`
  - `runner.runs_on`: Normalized `runs-on` label set (if available)
  - `runner.group`: Runner group (if available)

## Trace Specification

### Feature Control (Trace)

- **Environment Variable**: `FEATURE_TRACE` (default: true)
- **Tracer Name**: `github-actions-opentelemetry`
- **Exporter**: OTLP Protocol Buffer format

### Span Hierarchy

#### Root Workflow Span

- **Name**: Workflow name
- **Duration**: `workflow.run_started_at` to latest `job.completed_at` in that
  attempt (falls back to the earliest job `created_at` if unavailable)
- **Status**: Derived from workflow conclusion or 'in_progress'
- **Attributes**:
  - `span.type`: `'workflow'`
  - `repository`, `run_id`, `run_attempt`, `url`
  - `cicd.pipeline.task.run.id`, `cicd.pipeline.name`,
    `cicd.pipeline.run.url.full`
  - `workflow.conclusion`, `workflow.event`, `workflow.is_retry`
  - `workflow.wall_clock_duration_s`, `workflow.execution_duration_s`,
    `workflow.queued_duration_s`, `workflow.max_queued_duration_s`
  - `workflow.raw_billable_minutes`, `workflow.billable_minutes`,
    `workflow.rounding_waste_s`, `workflow.jobs_count`

#### Job Container Spans (`span.type = 'job.wrapper'`)

- **Name**: `{job.name} with time of waiting runner`
- **Duration**: `job.created_at` to `job.completed_at` (includes queue time)
- **Purpose**: Provides collapsible visual container in waterfall UIs without
  duplicating `job.conclusion` or billable attributes
- **Attributes**:
  - `span.type`: `'job.wrapper'`
  - `job.id`: GitHub job identifier
  - `job.name`: Job name
  - `job.run_attempt`: Numeric job attempt number

#### Job Queue Spans (Child, `span.type = 'queue'`)

- **Name**: `'job.queue'`
- **Duration**: `job.created_at` to `job.started_at`
- **Status**: Always 'success' (waiting is not an error condition)
- **Edge Case**: Skipped when queue duration is negative
- **Attributes**:
  - `span.type`: `'queue'`
  - `job.id`, `job.name`, `job.run_attempt`, `job.labels`,
    `job.queued_duration_s`
  - `runner.name`, `runner.group`, `runner.runs_on`, `runner.os`, `runner.arch`

#### Job Execution Spans (Child, `span.type = 'job'`)

- **Name**: Job name
- **Duration**: `job.started_at` to `job.completed_at`
- **Status**: Derived from job conclusion
- **Attributes**:
  - `span.type`: `'job'`
  - `job.id`, `job.name`, `job.run_attempt`, `job.conclusion`, `job.labels`
  - `runner.name`, `runner.group`, `runner.runs_on`, `runner.os`, `runner.arch`
  - `job.queued_duration_s`, `job.execution_duration_s`,
    `job.raw_billable_minutes`, `job.billable_minutes`,
    `job.billable_multiplier`, `job.rounding_waste_s`, `job.steps_count`

#### Step Spans (Grandchildren, `span.type = 'step'`)

- **Name**: Step name
- **Duration**: `step.started_at` to `step.completed_at`
- **Status**: Derived from step conclusion
- **Validation**: Steps with null timestamps are skipped with warnings
- **Attributes**:
  - `span.type`: `'step'`
  - `job.id`, `job.name`, `job.run_attempt`, `step.name`, `step.conclusion`,
    `step.number`

### Status Code Mapping

- **success** → `SpanStatusCode.OK`
- **failure, timed_out** → `SpanStatusCode.ERROR`
- **in_progress** → `SpanStatusCode.UNSET`
- **Others** → `SpanStatusCode.UNSET`

## Configuration

### Required Environment Variables

- **GITHUB_TOKEN**: GitHub API authentication (action input)

### Optional Environment Variables

- **FEATURE_METRICS**: Enable/disable metrics collection (default: true)
- **FEATURE_TRACE**: Enable/disable trace collection (default: true)
- **OTEL_EXPORTER_OTLP_ENDPOINT**: OTLP endpoint URL
- **OTEL_SERVICE_NAME**: Service identifier for telemetry
- **OTEL_RESOURCE_ATTRIBUTES**: Additional resource attributes
- **OTEL_LOG_LEVEL**: OpenTelemetry logging level
- **RUNNER_DEBUG**: GitHub Actions debug mode (sets log level to debug)

### Override Settings

- **WORKFLOW_RUN_ID**: Override target workflow run ID
- **OWNER**: Override repository owner
- **REPOSITORY**: Override repository name

## Error Handling

### Validation Errors

- Missing required job fields (conclusion, completed_at, workflow_name)
- Missing required step fields (started_at, completed_at)
- Invalid workflow status for workflow_run events

### Recoverable Issues

- Negative queue durations (GitHub API timing inconsistency)
- Missing step data (jobs without steps)
- Incomplete jobs in non-workflow_run events

### Retry Logic

- Automatic retry for GitHub API failures
- Configurable delay and maximum attempts
- Exponential backoff strategy
