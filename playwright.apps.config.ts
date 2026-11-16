import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Owning application journeys: detailed UI, runtime, recovery and authoring
// oracle coverage stays here even when it is outside the release selection.
export default defineConfig(base, {
  testMatch: [
    '**/builtin_apps_e2e_lifecycle.spec.ts',
    '**/content_workbench_e2e_lifecycle.spec.ts',
    '**/content_workbench_e2e_recovery.spec.ts',
    '**/content_workbench_e2e_media.spec.ts',
    '**/app_output_e2e_commerce.spec.ts',
    '**/saved_apps_e2e_lifecycle.spec.ts',
    '**/artifact_revisions_e2e_lifecycle.spec.ts',
    '**/web_app_sdk_e2e_lifecycle.spec.ts',
    '**/web_app_sdk_e2e_runtime.spec.ts',
    '**/web_app_permissions_e2e_usage.spec.ts',
    '**/html_preview_e2e_generated_controls.spec.ts',
    '**/resource_lifecycle_e2e_notes.spec.ts',
  ],
});
