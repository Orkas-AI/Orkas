import { defineConfig } from '@playwright/test';
import apps from './playwright.apps.config';

// Reuse owning cases; adding a detail/locale/parameter case must not silently
// expand the release gate. The cohort test checks actual Playwright discovery
// so renamed or missing critical journeys fail before a release run.
const criticalAppJourneys = [
  // Creation/editing, exactly-once dispatch and recoverable task submission.
  'creates a separate task once with 2 existing tasks',
  'keeps the description in the new task when sending is rejected and supports retry',
  'opens safely, renames, prepares an edit, persists, and deletes a saved app',
  // Local durability and explicit, non-destructive schema migration.
  'web app common data survives closing and reopening while host inference remains unavailable',
  'author can export, cancel, and explicitly clear incompatible local data before updating',
  // Real SDK wiring, application isolation and permission lifetime.
  'SDK app discovers, reads a selected file, generates, exports and keeps isolated state across reopening',
  'SDK tools discovery and execution read the real Library without redundant app consent',
  'isolated origin denies forged messages, foreign data and revoked SDK calls',
  'app approval uses Orkas UI, lasts for this use, isolates windows and honors Trusted',
];

export default defineConfig(apps, {
  grep: criticalAppJourneys.map(title => new RegExp(`(?:^| )${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
});
