/** The desktop launch flag for the Goal and What's new tabs. */
export function projectGoalAndRecapEnabled(): boolean {
  return process.env.ORKAS_PROJECT_RECAP_TAB_ENABLED === '1';
}
