'use strict';

function evaluateStdinCleanupFact(main, cleanup) {
  if (main.stdinEndedAt == null) return 'N/A (main stdin was not closed)';
  if (main.closedAt == null) return 'NO (main process stayed alive after stdin.end())';
  if (!cleanup) return 'NO (cleanup proof probe did not run)';
  if (cleanup.error) return `NO (cleanup proof probe failed: ${cleanup.error})`;
  if (!cleanup.sawTaskStarted) return 'NO (cleanup probe never observed a live background task)';
  if (!cleanup.sawResult) return 'NO (cleanup probe never reached its terminal result)';
  if (cleanup.stdinEndedAt == null) return 'NO (cleanup probe stdin was not closed)';
  if (cleanup.closedAt == null) return 'NO (cleanup probe process stayed alive)';
  if (cleanup.proofExists) return 'NO (background task survived and wrote its proof file)';
  return `YES after ${main.closedAt - main.stdinEndedAt}ms; live-task proof absent after cleanup`;
}

module.exports = { evaluateStdinCleanupFact };
