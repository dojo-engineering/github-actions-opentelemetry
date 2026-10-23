# Querying Workflow Metrics in Grafana

## TL;DR

This guide maps the action's OpenTelemetry workflow and job counters to the
Prometheus series names Grafana Cloud Mimir stores, and gives PromQL examples
for aggregating them across attempts. These names assume Grafana Cloud's default
OTLP-to-Prometheus mapping; the current observer workflow disables metrics, so
it does not emit these series.

---

## Context

The action emits OpenTelemetry metrics as well as traces. Grafana Cloud stores
OTLP metrics in Mimir, a Prometheus-compatible database, so these metrics can be
queried with PromQL. Tempo stores traces and is a separate signal backend; this
guide covers the action's counters, not metrics derived from spans.

---

## Findings

### Prometheus metric names

The action defines its metric names and attributes in
[`constants.ts`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/src/metrics/constants.ts)
and records the counter values and units in
[`create-counters.ts`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/src/metrics/create-counters.ts).
Under Grafana Cloud's default OTLP-to-Prometheus mapping, dots become
underscores, `s` becomes `seconds`, and `min` becomes `minutes`. Monotonic sums
get the `_total` suffix. The custom units `{run}` and `{job}` do not add a unit
suffix.

| OpenTelemetry metric                 | Prometheus/Mimir name                              | Meaning                                      |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------- |
| `github.workflow.runs`               | `github_workflow_runs_total`                       | Workflow attempts collected                  |
| `github.workflow.duration`           | `github_workflow_duration_seconds_total`           | Elapsed wall-clock time for an attempt       |
| `github.workflow.execution_duration` | `github_workflow_execution_duration_seconds_total` | Sum of job execution durations in an attempt |
| `github.workflow.billable_time`      | `github_workflow_billable_time_minutes_total`      | GitHub-hosted billable time in an attempt    |
| `github.workflow.rounding_waste`     | `github_workflow_rounding_waste_seconds_total`     | Billable rounding waste in an attempt        |
| `github.job.runs`                    | `github_job_runs_total`                            | Job runs collected                           |
| `github.job.duration`                | `github_job_duration_seconds_total`                | Job execution duration                       |
| `github.job.queued_duration`         | `github_job_queued_duration_seconds_total`         | Time from job creation to start              |
| `github.job.billable_time`           | `github_job_billable_time_minutes_total`           | GitHub-hosted billable time for a job        |
| `github.job.raw_billable_time`       | `github_job_raw_billable_time_minutes_total`       | Raw billable time for a job                  |
| `github.job.rounding_waste`          | `github_job_rounding_waste_seconds_total`          | Billable rounding waste for a job            |

These Prometheus names follow
[Grafana Cloud's OTLP metric naming rules](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/#suffixes-added-to-metric-names).
A custom OTLP gateway or a different translation strategy may produce different
names.

### Labels and attempt-level series

The metric attributes are Prometheus labels. Grafana converts dots in attribute
names to underscores, so common labels include `workflow_name`,
`workflow_run_id`, `workflow_run_attempt`, `workflow_conclusion`,
`workflow_event`, and `workflow_is_retry`. Job metrics also include `job_name`,
`job_conclusion`, `job_run_attempt`, and runner labels such as `runner_os` and
`runner_arch`. The attribute definitions are in
[`constants.ts`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/src/metrics/constants.ts).

Workflow metrics include both `workflow.run_id` and `workflow.run_attempt`,
which creates separate series for each attempt. The workflow run counter adds
one per collected attempt, including partial reruns; job metrics include the
jobs executed in that attempt. See
[`specification.md`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/docs/specification.md)
for the attempt-scoping rules.

To aggregate across attempts, use `last_over_time` to select the latest
cumulative sample for each series in the query window, then sum while retaining
the workflow name and, when needed, repository. This avoids adding repeated
cumulative samples from the same series. `rate()` and `increase()` are not
useful for these short-lived, attempt-scoped series.

### PromQL examples

The examples use a 30-day window. Change `[30d]` to the time range you want to
analyze.

Count workflow attempts by repository and workflow:

```promql
sum by (repository, workflow_name) (
  last_over_time(github_workflow_runs_total[30d])
)
```

Total GitHub-billable minutes by workflow:

```promql
sum by (repository, workflow_name) (
  last_over_time(github_workflow_billable_time_minutes_total[30d])
)
```

Total job execution minutes by workflow. Parallel jobs contribute their
individual durations, so this can exceed elapsed wall-clock time:

```promql
sum by (repository, workflow_name) (
  last_over_time(github_workflow_execution_duration_seconds_total[30d])
) / 60
```

Billable minutes by workflow and job:

```promql
sum by (repository, workflow_name, job_name) (
  last_over_time(github_job_billable_time_minutes_total[30d])
)
```

Average elapsed wall-clock seconds per workflow attempt:

```promql
sum by (repository, workflow_name) (
  last_over_time(github_workflow_duration_seconds_total[30d])
)
/
sum by (repository, workflow_name) (
  last_over_time(github_workflow_runs_total[30d])
)
```

Add label filters inside the metric selector to focus on a particular repository
or workflow, for example
`{repository="dojo-engineering/github-actions-opentelemetry", workflow_name="Push Event Tests"}`.

---

## Key Components

| Component                             | Role                                                             | Location                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metric descriptors and attribute keys | Defines OpenTelemetry names and attribute keys                   | [`constants.ts`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/src/metrics/constants.ts)                         |
| Counter creation                      | Computes and records workflow/job counter values                 | [`create-counters.ts`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/src/metrics/create-counters.ts)             |
| Metric and trace exporters            | Configures OTLP exporters and metric reader                      | [`instrumentation.ts`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/src/instrumentation/instrumentation.ts)     |
| Feature flags                         | Defaults metrics and traces to enabled unless overridden         | [`settings.ts`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/src/settings.ts)                                   |
| Observer workflow                     | Runs the action for completed Push Event Tests workflows         | [`observe-workflow.yaml`](https://github.com/dojo-engineering/github-actions-opentelemetry/blob/eb36d2e8835e8740b47452272dd6fc86f7659f66/.github/workflows/observe-workflow.yaml) |
| Grafana metrics storage               | Stores Grafana Cloud metrics in a Prometheus-compatible database | [Grafana Cloud OTLP documentation](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/)                                                             |
