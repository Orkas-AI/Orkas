/**
 * CLI command system for core-agent.
 *
 * Provides a simple, extensible command framework with built-in commands:
 *   run     — one-shot agent execution
 *   chat    — interactive chat loop
 *   config  — show/validate configuration
 *   memory  — memory status and search
 *   models  — list available providers and models
 */
import { createInterface } from "node:readline";
import { createConfig, loadConfig } from "../config/index.js";
import type { CoreAgentConfig } from "../config/index.js";
import { AgentRunner } from "../agent/index.js";
import { ProviderRegistry } from "../providers/registry.js";
import { listPiProviders, listPiModels } from "../providers/pi-provider.js";
import { MemoryIndexManager } from "../memory/manager.js";
import { SqliteMemoryManager } from "../memory/sqlite-manager.js";
import { createLogger } from "../shared/logger.js";
import { listCredentials, removeCredential, writeApiKeyCredential } from "../auth/store.js";
import { loginOAuthProvider } from "../auth/oauth-flow.js";

const log = createLogger("cli");

/** A CLI command definition. */
export interface CLICommand {
  name: string;
  description: string;
  usage?: string;
  execute(args: string[], opts: ParsedOpts): Promise<void>;
}

/** Parsed command-line options. */
interface ParsedOpts {
  flags: Record<string, string | boolean>;
  positional: string[];
}

/** Parse argv into flags and positional args. */
function parseArgs(args: string[]): ParsedOpts {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/**
 * CLI is the main entry point for the command-line interface.
 *
 * Usage:
 *   const cli = new CLI();
 *   cli.register(myCommand);
 *   await cli.run(process.argv.slice(2));
 */
export class CLI {
  private commands = new Map<string, CLICommand>();

  constructor() {
    // Register built-in commands
    this.register(runCommand);
    this.register(chatCommand);
    this.register(configCommand);
    this.register(memoryCommand);
    this.register(modelsCommand);
    this.register(loginCommand);
    this.register(authCommand);
    this.register(helpCommand(this));
  }

  /** Register a custom command. */
  register(cmd: CLICommand): void {
    this.commands.set(cmd.name, cmd);
  }

  /** Get all registered commands. */
  getCommands(): CLICommand[] {
    return [...this.commands.values()];
  }

  /** Run the CLI with the given argv (after stripping node/script). */
  async run(argv: string[]): Promise<void> {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      await this.commands.get("help")!.execute([], parseArgs([]));
      return;
    }

    const commandName = argv[0];
    const command = this.commands.get(commandName);

    if (!command) {
      console.error(`Unknown command: ${commandName}`);
      console.error('Run "core-agent help" for available commands.');
      process.exitCode = 1;
      return;
    }

    const opts = parseArgs(argv.slice(1));
    await command.execute(argv.slice(1), opts);
  }
}

// ─── Built-in commands ────────────────────────────────────────────────────

/** `run` — one-shot agent execution. */
const runCommand: CLICommand = {
  name: "run",
  description: "Run the agent with a single message",
  usage: "run [--provider <name>] [--model <name>] [--config <path>] <message>",
  async execute(_args, opts) {
    const configPath = opts.flags.config as string | undefined;
    const config = configPath ? await loadConfig(configPath) : createConfig({
      agent: {
        ...(opts.flags.provider ? { defaultProvider: opts.flags.provider as string } : {}),
        ...(opts.flags.model ? { defaultModel: opts.flags.model as string } : {}),
      },
    });

    const message = opts.positional.join(" ");
    if (!message) {
      console.error("Error: No message provided.");
      console.error("Usage: core-agent run <message>");
      process.exitCode = 1;
      return;
    }

    const runner = new AgentRunner({ config });

    console.log(`Provider: ${config.agent.defaultProvider}`);
    console.log(`Model: ${config.agent.defaultModel}`);
    console.log(`Message: ${message}\n`);

    const result = await runner.run({ message });

    if (result.meta.error) {
      console.error(`Error: ${result.meta.error.kind} — ${result.meta.error.message}`);
      process.exitCode = 1;
      return;
    }

    console.log(result.text);
    console.log(`\n--- ${result.meta.model} | ${result.meta.durationMs}ms | ${result.meta.usage.totalTokens} tokens | ${result.meta.toolLoops} tool loops ---`);
  },
};

/** `chat` — interactive chat loop. */
const chatCommand: CLICommand = {
  name: "chat",
  description: "Start an interactive chat session",
  usage: "chat [--provider <name>] [--model <name>] [--config <path>]",
  async execute(_args, opts) {
    const configPath = opts.flags.config as string | undefined;
    const config = configPath ? await loadConfig(configPath) : createConfig({
      agent: {
        ...(opts.flags.provider ? { defaultProvider: opts.flags.provider as string } : {}),
        ...(opts.flags.model ? { defaultModel: opts.flags.model as string } : {}),
      },
    });

    const runner = new AgentRunner({ config });

    console.log(`=== core-agent chat ===`);
    console.log(`Provider: ${config.agent.defaultProvider} | Model: ${config.agent.defaultModel}`);
    console.log('Type "exit" or "quit" to end the session.\n');

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): Promise<string> =>
      new Promise((resolve) => rl.question("you> ", resolve));

    try {
      while (true) {
        const input = await prompt();
        const trimmed = input.trim();

        if (!trimmed) continue;
        if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit" || trimmed === "/quit") {
          console.log("Goodbye!");
          break;
        }

        // Special commands within chat
        if (trimmed === "/clear") {
          runner.getSession().clear();
          console.log("Session cleared.\n");
          continue;
        }
        if (trimmed === "/status") {
          const session = runner.getSession();
          console.log(`Messages: ${session.length}`);
          console.log(`Estimated tokens: ${session.estimateTokens()}\n`);
          continue;
        }

        try {
          const result = await runner.run({ message: trimmed });

          if (result.meta.error) {
            console.error(`[error] ${result.meta.error.kind}: ${result.meta.error.message}\n`);
            continue;
          }

          console.log(`\nassistant> ${result.text}`);
          console.log(`  [${result.meta.model} | ${result.meta.durationMs}ms | ${result.meta.usage.totalTokens} tokens]\n`);
        } catch (err) {
          console.error(`[error] ${(err as Error).message}\n`);
        }
      }
    } finally {
      rl.close();
    }
  },
};

/** `config` — show/validate configuration. */
const configCommand: CLICommand = {
  name: "config",
  description: "Show or validate configuration",
  usage: "config [--config <path>] [--validate]",
  async execute(_args, opts) {
    const configPath = opts.flags.config as string | undefined;

    try {
      const config = configPath ? await loadConfig(configPath) : createConfig();

      if (opts.flags.validate) {
        console.log("Configuration is valid.");
      }

      console.log(JSON.stringify(config, null, 2));
    } catch (err) {
      console.error(`Configuration error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  },
};

/** `memory` — memory status and search. */
const memoryCommand: CLICommand = {
  name: "memory",
  description: "Memory status, search, or sync",
  usage: "memory [status|search|sync] [--dir <path>] [--query <text>] [--sqlite]",
  async execute(_args, opts) {
    const subcommand = opts.positional[0] ?? "status";
    const memoryDir = (opts.flags.dir as string) ?? "./memory";
    const useSqlite = Boolean(opts.flags.sqlite);
    const config = createConfig();

    const manager = useSqlite
      ? new SqliteMemoryManager({ memoryDir, config: config.memory })
      : new MemoryIndexManager({ memoryDir, config: config.memory });

    try {
      switch (subcommand) {
        case "status": {
          await manager.sync();
          const status = manager.status();
          console.log("Memory Status:");
          console.log(`  Provider: ${status.provider}`);
          console.log(`  Files: ${status.files}`);
          console.log(`  Chunks: ${status.chunks}`);
          console.log(`  FTS: ${status.fts.enabled ? "enabled" : "disabled"}`);
          console.log(`  Vector: ${status.vector.enabled ? "enabled" : "disabled"}${status.vector.dims ? ` (${status.vector.dims}d)` : ""}`);
          if (useSqlite) console.log(`  Backend: SQLite`);
          break;
        }
        case "search": {
          const query = (opts.flags.query as string) ?? opts.positional.slice(1).join(" ");
          if (!query) {
            console.error("Error: No search query provided.");
            console.error("Usage: memory search --query <text>");
            process.exitCode = 1;
            return;
          }
          await manager.sync();
          const results = await manager.search(query);
          if (results.length === 0) {
            console.log("No results found.");
          } else {
            for (const r of results) {
              console.log(`[${r.score.toFixed(2)}] ${r.path} (lines ${r.startLine}-${r.endLine})`);
              console.log(`  ${r.snippet.slice(0, 120)}...\n`);
            }
          }
          break;
        }
        case "sync": {
          await manager.sync({ force: true });
          const status = manager.status();
          console.log(`Synced: ${status.files} files, ${status.chunks} chunks`);
          break;
        }
        default:
          console.error(`Unknown memory subcommand: ${subcommand}`);
          process.exitCode = 1;
      }
    } finally {
      await manager.close?.();
    }
  },
};

/** `models` — list providers and models. */
const modelsCommand: CLICommand = {
  name: "models",
  description: "List available providers and models",
  usage: "models [--provider <name>]",
  async execute(_args, opts) {
    const providerFilter = opts.flags.provider as string | undefined;

    if (providerFilter) {
      const models = listPiModels(providerFilter);
      if (models.length === 0) {
        console.log(`No models found for provider: ${providerFilter}`);
        return;
      }
      console.log(`Models for ${providerFilter}:`);
      for (const m of models) {
        console.log(`  ${m.id}  (ctx: ${(m.contextWindow / 1000).toFixed(0)}k)`);
      }
    } else {
      const providers = listPiProviders();
      console.log(`Available providers (${providers.length}):`);
      for (const p of providers) {
        const models = listPiModels(p);
        console.log(`  ${p} (${models.length} models)`);
      }
      console.log('\nUse "models --provider <name>" to see models for a specific provider.');
    }
  },
};

/** `login` — OAuth login for a provider. */
const loginCommand: CLICommand = {
  name: "login",
  description: "Authenticate with a provider via OAuth or API key",
  usage: "login <provider> [--method oauth|api-key]",
  async execute(_args, opts) {
    const provider = opts.positional[0];
    if (!provider) {
      console.error("Error: No provider specified.");
      console.error("Usage: core-agent login <provider> [--method oauth|api-key]");
      console.error("");
      // List available OAuth providers
      try {
        const { getOAuthProviders } = await import("@earendil-works/pi-ai/oauth");
        const oauthProviders = getOAuthProviders();
        if (oauthProviders.length > 0) {
          console.error("Available OAuth providers:");
          for (const p of oauthProviders) {
            console.error(`  ${p.id} (${p.name})`);
          }
        }
      } catch {
        // pi-ai oauth module not available
      }
      console.error("\nYou can also use --method api-key for any provider.");
      process.exitCode = 1;
      return;
    }

    const method = (opts.flags.method as string) ?? "oauth";

    if (method === "api-key") {
      // Simple API key flow
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const apiKey = await new Promise<string>((resolve) => {
        rl.question("Enter API key: ", (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });

      if (!apiKey) {
        console.error("Error: No API key provided.");
        process.exitCode = 1;
        return;
      }

      writeApiKeyCredential(provider, apiKey);
      console.log(`API key saved for ${provider}.`);
      return;
    }

    // OAuth flow
    try {
      const { getOAuthProvider } = await import("@earendil-works/pi-ai/oauth");
      const oauthProvider = getOAuthProvider(provider);

      if (!oauthProvider) {
        console.error(`Error: No OAuth provider found for "${provider}".`);
        console.error("");
        const { getOAuthProviders } = await import("@earendil-works/pi-ai/oauth");
        const available = getOAuthProviders();
        if (available.length > 0) {
          console.error("Available OAuth providers:");
          for (const p of available) {
            console.error(`  ${p.id} (${p.name})`);
          }
        }
        console.error(`\nTip: Use --method api-key to authenticate with an API key instead.`);
        process.exitCode = 1;
        return;
      }

      await loginOAuthProvider(oauthProvider);
    } catch (err) {
      console.error(`OAuth login failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  },
};

/** `auth` — manage stored credentials. */
const authCommand: CLICommand = {
  name: "auth",
  description: "List or manage stored credentials",
  usage: "auth [list|remove <profileId>|status]",
  async execute(_args, opts) {
    const subcommand = opts.positional[0] ?? "list";

    switch (subcommand) {
      case "list":
      case "status": {
        const creds = listCredentials();
        if (creds.length === 0) {
          console.log("No stored credentials.");
          console.log('Run "core-agent login <provider>" to authenticate.');
          return;
        }
        console.log("Stored credentials:\n");
        for (const c of creds) {
          const status =
            c.type === "oauth"
              ? c.expired
                ? " (expired — will auto-refresh)"
                : " (valid)"
              : "";
          console.log(`  ${c.profileId}`);
          console.log(`    Provider: ${c.provider}`);
          console.log(`    Type: ${c.type}${status}`);
          console.log("");
        }
        break;
      }
      case "remove": {
        const profileId = opts.positional[1];
        if (!profileId) {
          console.error("Error: No profile ID specified.");
          console.error("Usage: core-agent auth remove <profileId>");
          process.exitCode = 1;
          return;
        }
        const removed = removeCredential(profileId);
        if (removed) {
          console.log(`Removed credential: ${profileId}`);
        } else {
          console.error(`Credential not found: ${profileId}`);
          process.exitCode = 1;
        }
        break;
      }
      default:
        console.error(`Unknown auth subcommand: ${subcommand}`);
        console.error("Usage: core-agent auth [list|remove <profileId>]");
        process.exitCode = 1;
    }
  },
};

/** `help` — show help. */
function helpCommand(cli: CLI): CLICommand {
  return {
    name: "help",
    description: "Show help information",
    async execute(_args, _opts) {
      console.log("core-agent — LLM agent harness powered by @earendil-works/pi-ai\n");
      console.log("Usage: core-agent <command> [options]\n");
      console.log("Commands:");
      for (const cmd of cli.getCommands()) {
        const usage = cmd.usage ? `  ${cmd.usage}` : "";
        console.log(`  ${cmd.name.padEnd(10)} ${cmd.description}`);
        if (usage) console.log(`             ${usage}`);
      }
      console.log("\nGlobal options:");
      console.log("  --help     Show this help message");
    },
  };
}
