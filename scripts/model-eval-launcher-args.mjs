/** Electron retains host switches before its entry in process.argv. Locate
 * that dispatched entry rather than assuming the runner starts at index 2. */
export function modelEvalRunnerArgs(argv, entry) {
  const index = argv.indexOf(entry, 1);
  if (index < 1) throw new Error('Model evaluation entry is missing from process arguments');
  return argv.slice(index + 1);
}
