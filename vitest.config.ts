import { defineConfig } from 'vitest/config'

const isCI = process.env.CI === 'true'

// Usually, devcontainer environment is used for local test.
// But, if you want to test in local environment without devcontainer,
// you can set DEV_CONTAINER=false in your shell environment.
// This option is for Kiro because https://github.com/kirodotdev/Kiro/issues/164
const isDevContainer = process.env.DEV_CONTAINER !== 'false'

// Use appropriate hostnames based on environment
const metricsEndpoint = isDevContainer
  ? 'http://prometheus:9090/api/v1/otlp/v1/metrics'
  : 'http://localhost:9090/api/v1/otlp/v1/metrics'

const tracesEndpoint = isDevContainer
  ? 'http://jaeger:4318/v1/traces'
  : 'http://localhost:4318/v1/traces'

const defaultEnv = {
  FEATURE_METRICS: 'true',
  FEATURE_TRACE: 'true',
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metricsEndpoint,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesEndpoint,
  OTEL_SERVICE_NAME: 'github-actions-opentelemetry',
  // OTEL_RESOURCE_ATTRIBUTES: Used to test custom resource attributes functionality
  // These test attributes are verified in create-trace.test.ts and create-metrics.test.ts
  OTEL_RESOURCE_ATTRIBUTES: 'test.attribute=example,test.attribute2=example2'
}

const CIEnv = {
  ...defaultEnv,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined
}

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['json-summary', 'text', 'lcov'],
      include: ['src']
    },
    env: isCI ? CIEnv : defaultEnv
  }
})
