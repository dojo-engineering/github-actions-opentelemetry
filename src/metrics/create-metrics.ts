import settings from '../settings.js'
import { createWorkflowCounters, createJobCounters } from './create-counters.js'
import { WorkflowResults } from '../github/types.js'

export const createMetrics = async (
  results: WorkflowResults
): Promise<void> => {
  const { workflow: workflow, workflowJobs: workflowJobs } = results
  if (!settings.FeatureFlagMetrics) {
    console.log('metrics feature is disabled.')
    return
  }
  try {
    createWorkflowCounters(workflow, workflowJobs)
    createJobCounters(workflow, workflowJobs)
  } catch (error) {
    console.error('failed to create metrics')
    throw error
  }
}
