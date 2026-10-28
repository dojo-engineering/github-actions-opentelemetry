# GitHub Actions OpenTelemetry

> [!IMPORTANT] This github action is currently owned by payments maturity
> (resilliance). But Platform B&P may also be able to assit

[![On Main](https://github.com/dojo-engineering/github-actions-opentelemetry/actions/workflows/on-main.yml/badge.svg?branch=main)](https://github.com/dojo-engineering/github-actions-opentelemetry/actions/workflows/on-main.yml)
[![Push Event Tests](https://github.com/dojo-engineering/github-actions-opentelemetry/actions/workflows/push-event-tests.yml/badge.svg?branch=main)](https://github.com/dojo-engineering/github-actions-opentelemetry/actions/workflows/push-event-tests.yml)
[![Workflow Run Tests](https://github.com/dojo-engineering/github-actions-opentelemetry/actions/workflows/workflow-run-tests.yml/badge.svg?branch=main)](https://github.com/dojo-engineering/github-actions-opentelemetry/actions/workflows/workflow-run-tests.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

This action sends metrics and traces of GitHub Actions to an OpenTelemetry
Protocol (OTLP) endpoint. It helps you monitor and analyze GitHub Actions.

## Features Summary

- 📊 Collects Metrics of GitHub Actions workflows and job execution times
- 🔍 Collects Traces of GitHub Actions workflow, jobs, steps.
- 📦 Sends data to any OTLP-compatible backend for monitoring and observability
- 🚀 Collect telemetry without modifying existing workflows

## Metrics

All metrics are exported as OpenTelemetry **Counters** (`createCounter`).
Workflow metrics include `workflow.run_id` and `workflow.run_attempt`, so
independent workflow runs and attempts use separate metric series. The default
OTLP exporter temporality is cumulative. To get a total over a time range, sum
the per-attempt points by `workflow.name`, dropping run, attempt, outcome, and
event dimensions. Keep `repository` when totals should remain separate across
repositories:

| Descriptor Name                 | Unit  | Description                                                                   |
| ------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `github.workflow.runs`          | `1`   | Count of collected attempts (including partial reruns in `workflow_run` mode) |
| `github.workflow.duration`      | `s`   | Elapsed duration of one workflow attempt                                      |
| `github.workflow.billable_time` | `min` | GitHub-hosted billable time of workflow in minutes (with OS multipliers)      |
| `github.job.runs`               | `1`   | Count of job runs                                                             |
| `github.job.duration`           | `s`   | Duration of job                                                               |
| `github.job.queued_duration`    | `s`   | Duration of queued job                                                        |
| `github.job.billable_time`      | `min` | GitHub-hosted billable time of job (rounded up to 60s + OS multiplier)        |
| `github.job.rounding_waste`     | `s`   | Billable rounding waste of job in seconds                                     |

Each metric has associated attributes:

- **Workflow metrics**: `workflow.name`, `repository`, `workflow.conclusion`,
  `workflow.event`, `workflow.is_retry`, `workflow.run_attempt`,
  `workflow.run_id`
- **Job metrics**: `workflow.name`, `workflow.run_id`, `workflow.run_attempt`,
  `repository`, `job.name`, `job.conclusion`, `job.run_attempt`, `runner.os`,
  `runner.arch`, `runner.runs_on`, `runner.group`

Each action invocation reports only jobs executed in that workflow attempt.
`workflow.run_id` and `workflow.run_attempt` intentionally scope metric series
per attempt; sum the per-attempt points by workflow name over the desired time
range to calculate totals. Self-hosted jobs still contribute execution duration
and runner metadata, but contribute zero to GitHub-hosted billable time and
rounding waste.

![Prometheus Example Screen Shot](./img/metrics-prom.png)

## Traces

![Jaeger Example Screen Shot](./img/traces-jager.png)

![Attributes Sample](./img/trace-attributes.png)

Traces include structured attributes and a `span.type` discriminator
(`workflow`, `job.wrapper`, `queue`, `job`, `step`) to prevent double-counting
while keeping a clean collapsible waterfall UI:

Each trace represents one workflow attempt. Reruns have the same `run_id` and a
distinct `run_attempt`; only jobs executed in that attempt are included.

- **Workflow-level attributes** (`span.type = 'workflow'`): `run_id`,
  `run_attempt`, `repository`, `url`, `workflow.conclusion`, `workflow.event`,
  `workflow.is_retry`, `workflow.wall_clock_duration_s`,
  `workflow.execution_duration_s`, `workflow.queued_duration_s`,
  `workflow.max_queued_duration_s`, `workflow.raw_billable_minutes`,
  `workflow.billable_minutes`, `workflow.rounding_waste_s`,
  `workflow.jobs_count`
- **Job Wrapper attributes** (`span.type = 'job.wrapper'`): `job.id`,
  `job.name`, `job.run_attempt`
- **Job Queue attributes** (`name = 'job.queue'`, `span.type = 'queue'`):
  `job.id`, `job.name`, `job.run_attempt`, `job.labels`,
  `job.queued_duration_s`, `runner.name`, `runner.group`, `runner.runs_on`,
  `runner.os`, `runner.arch`
- **Job Execution attributes** (`span.type = 'job'`): `job.id`, `job.name`,
  `job.run_attempt`, `job.conclusion`, `job.labels`, `runner.name`,
  `runner.group`, `runner.runs_on`, `runner.os`, `runner.arch`,
  `job.queued_duration_s`, `job.execution_duration_s`,
  `job.raw_billable_minutes`, `job.billable_minutes`, `job.billable_multiplier`,
  `job.rounding_waste_s`, `job.steps_count`
- **Step attributes** (`span.type = 'step'`): `job.name`, `step.name`, `job.id`,
  `job.run_attempt`, `step.conclusion`, `step.number`

You can find a trace by the `run_id` attribute attached to the root span.
`run_id` is visible in the workflow results URL. For example, if the URL is:

```txt
https://github.com/paper2/github-actions-opentelemetry/actions/runs/12246387114
```

Then the `run_id` is `12246387114`.

### Adding Custom Resource Attributes

You can add custom attributes to all traces and metrics using the
`OTEL_RESOURCE_ATTRIBUTES` environment variable. This is useful for adding
context like environment, or team information:

```yaml
env:
  OTEL_RESOURCE_ATTRIBUTES: 'environment=production,team=backend'
```

These custom attributes will be included as resource attributes in all exported
telemetry data.

![search-trace-run-id](./img/search-trace-run-id.png)

## Trace ID Summary

After the action completes, you'll see the workflow trace ID displayed in the
GitHub Actions summary for easy access:

![Trace ID Summary](./img/trace-id-summary.png)

## How it works

This action creates metrics and traces of GitHub Actions workflows and sends
them to an OTLP endpoint. It uses the GitHub API to collect data about completed
workflows and jobs. The action then sends this data to the OTLP endpoint for
monitoring and observability.

```mermaid
sequenceDiagram
  participant TW as Target Workflow
  participant GAOW as GitHub Actions OpenTelemetry Workflow
  participant GA as GitHub API
  participant OE as OTLP Endpoint

  TW ->> TW: Complete Workflow
  TW ->> GAOW: Trigger by workflow_run
  GAOW ->> GA: Get Target Workflow Data
  GAOW ->> OE: Send Metrics and Traces
```

## Setup Instructions

1. **Create OTLP Endpoint**: Set up an OTLP backend to receive telemetry data
   (e.g., Jaeger, Prometheus, or other monitoring tools).
1. **Add a Workflow**: Create a new workflow file and use this action triggered
   by
   [workflow_run](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_run)
   because this action collects telemetry of completed workflows.

### GitHub Actions Examples

#### Option 1: Monitor Other Workflows

Monitor completed workflows triggered by `workflow_run` events:

```yaml
name: Send Telemetry after Other Workflow

on:
  workflow_run:
    # Specify the workflows you want to collect telemetry.
    workflows:
      - Check Transpiled JavaScript
      - Continuous Integration
      - CodeQL
      - Lint Codebase
    # This action uses completed workflow for making traces and metrics.
    types:
      - completed

permissions:
  # Required for private repositories
  actions: read

jobs:
  send-telemetry:
    name: Send CI Telemetry
    runs-on: ubuntu-latest
    steps:
      - name: Run
        id: run
        # Replace <OWNER>/<REPO>@<REF> with your chosen fork or release ref.
        uses: <OWNER>/<REPO>@<REF>
        env:
          OTEL_SERVICE_NAME: github-actions-opentelemetry
          OTEL_EXPORTER_OTLP_ENDPOINT: https://collector-example.com
          # Additional OTLP headers use comma-separated header-name=value pairs.
          # Grafana Tempo API-key auth: store X-API-Key=<token> as the full secret value.
          # Reference that secret directly; do not add another header-name prefix.
          # e.g.
          # New Relic: api-key=YOUR_NEWRELIC_API_KEY
          # Google Cloud Run: Authorization=Bearer <value of $(gcloud auth print-identity-token)>
          # Basic Authentication: Authorization=Basic <base64-encoded value of userid:password>
          OTEL_EXPORTER_OTLP_HEADERS:
            ${{ secrets.REPO_GRAFANA_TRACE_AUTH_HEADER }}
          OTEL_RESOURCE_ATTRIBUTES: 'environment=ci,team=backend'
        with:
          # Required for collecting workflow data
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

#### Option 2: Monitor Current Workflow (Experimental)

Monitor the current workflow by running this action as the last step:

```yaml
name: CI with Built-in Telemetry

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test

  # Telemetry job runs after all other jobs complete
  telemetry:
    runs-on: ubuntu-latest
    needs: [build, test] # Wait for other jobs to complete
    if: always() # Run even if other jobs fail
    steps:
      - name: Send Telemetry
        # Replace <OWNER>/<REPO>@<REF> with your chosen fork or release ref.
        uses: <OWNER>/<REPO>@<REF>
        env:
          OTEL_SERVICE_NAME: github-actions-opentelemetry
          OTEL_EXPORTER_OTLP_ENDPOINT: https://collector-example.com
          # Additional OTLP headers use comma-separated header-name=value pairs.
          # Grafana Tempo API-key auth: store X-API-Key=<token> as the full secret value.
          # Reference that secret directly; do not add another header-name prefix.
          # e.g.
          # New Relic: api-key=YOUR_NEWRELIC_API_KEY
          # Google Cloud Run: Authorization=Bearer <value of $(gcloud auth print-identity-token)>
          # Basic Authentication: Authorization=Basic <base64-encoded value of userid:password>
          OTEL_EXPORTER_OTLP_HEADERS:
            ${{ secrets.REPO_GRAFANA_TRACE_AUTH_HEADER }}
          OTEL_RESOURCE_ATTRIBUTES: 'environment=ci,team=backend'
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

In current-workflow mode, only attempts that execute the telemetry job are
reported. Use `workflow_run` mode to capture every partial rerun.

### Configuration

To configure the action, you need to set the following environment variables:

| Environment Variable                  | Required | Default Value | Description                                                                                          |
| ------------------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `OTEL_SERVICE_NAME`                   | Yes      | -             | Service name.                                                                                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Yes      | -             | OTLP Endpoint for Traces and Metrics. e.g., <https://collector-example.com>                          |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | No       | -             | OTLP Endpoint for Metrics instead of OTEL_EXPORTER_OTLP_ENDPOINT.                                    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | No       | -             | OTLP Endpoint for Traces instead of OTEL_EXPORTER_OTLP_ENDPOINT.                                     |
| `OTEL_EXPORTER_OTLP_HEADERS`          | No       | -             | Comma-separated OTLP headers in `header-name=header-value` format. See the Grafana Tempo note below. |
| `OTEL_RESOURCE_ATTRIBUTES`            | No       | -             | Additional resource attributes for traces and metrics. e.g., "environment=production,team=backend"   |
| `FEATURE_TRACE`                       | No       | `true`        | Enable trace feature.                                                                                |
| `FEATURE_METRICS`                     | No       | `true`        | Enable Metrics feature.                                                                              |
| `OTEL_LOG_LEVEL`                      | No       | `info`        | Log level.                                                                                           |

For a Grafana Tempo endpoint configured for API-key authentication, use
`X-API-Key=<token>`. Store the complete pair in the GitHub secret and assign
that secret directly to `OTEL_EXPORTER_OTLP_HEADERS`; do not add another
header-name prefix such as `api-key=`. `OTEL_EXPORTER_OTLP_HEADERS` uses `=`
between the header name and value, not the HTTP wire format's `:`.
Authentication requirements depend on the Tempo endpoint or gateway.

### Getting Started

We prepared a [Getting Started](./examples/google-cloud/README.md) to create
OpenTelemetry backend and run this action by using Google Cloud.

## Limitations

There are some limitations that come from GitHub Actions Specification. See
[Specification](https://github.com/paper2/github-actions-opentelemetry/wiki/Specification)
page for details.

## Development

### Dev Container

You can run containers by
[devcontainer](https://code.visualstudio.com/docs/devcontainers/containers).

- Jaeger and Prometheus run for local testing.
  - Jaeger: <http://localhost:16686>
  - Prometheus: <http://localhost:9090>

### Local test

You can run all tests below command.

```sh
npm run test
```

You can run a simple test. It is useful for checking output while developing.

```sh
npm run test-local
```

### Compile

TypeScript codes must be compiled by ncc. You have changed code, run bellow the
command.

```sh
npm run all
```

> [!NOTE]  
> This command creates `index.js` and more on the `/dist` directory. You must
> includes these artifacts on a commit because GitHub Actions uses these files.

### Recommend to install GitHub CLI (gh)

Tests invoke real GitHub API. Unauthenticated users are subject to strict API
rate limits. If `gh` command is installed and login is finished, token is
automatically set for tests by `vitest.config.ts`.

the login command is below.

```sh
gh auth login
```

If you face below error, recommend to install GitHub CLI and login.

```text
message: "API rate limit exceeded for xx.xx.xx.xx. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)",
documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting'
```

### Default Environment Variables for Testing

Some environment variables are set on `vitest.config.ts`.

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE)
file for details.

## Contributing

Contributions are welcome! Submit a pull request with your changes. Before
contributing, ensure that your changes are well-documented and tested.

## Support

If you encounter any issues or have questions, feel free to open an issue in the
repository. We will do our best to assist you promptly.
