import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { CoreAgentConfigSchema, type CoreAgentConfig } from "./schema.js";

/** Input type for config — allows partial values with defaults. */
export type CoreAgentConfigInput = z.input<typeof CoreAgentConfigSchema>;

/**
 * Load configuration from a JSON or JSON5 file.
 * Falls back to defaults if no file is found.
 */
export async function loadConfig(configPath?: string): Promise<CoreAgentConfig> {
  if (!configPath) {
    return CoreAgentConfigSchema.parse({});
  }

  const resolved = path.resolve(configPath);
  try {
    const raw = await fs.readFile(resolved, "utf-8");
    const data = JSON.parse(raw);
    return CoreAgentConfigSchema.parse(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return CoreAgentConfigSchema.parse({});
    }
    throw err;
  }
}

/**
 * Create a config object from partial values, applying defaults.
 */
export function createConfig(partial: CoreAgentConfigInput = {}): CoreAgentConfig {
  return CoreAgentConfigSchema.parse(partial);
}
