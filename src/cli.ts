#!/usr/bin/env node

/**
 * Network Monitoring CLI Tool
 * Terminal TUI for monitoring active ports
 */

import { Dashboard } from "./tui/dashboard.js";
import { killPortByNumber } from "./actions/port-actions.js";
import type { SortOption } from "./utils/filter-utils.js";
import { HELP_TEXT } from "./cli/help.js";

interface CLIOptions {
  type?: string;
  user?: string;
  process?: string;
  sort?: SortOption;
  help?: boolean;
  version?: boolean;
  port?: string;
  force?: boolean;
}

interface ParsedArgs {
  command?: string;
  options: CLIOptions;
  args: string[];
}

function parseArgs(): ParsedArgs {
  // Use Node.js process.argv
  const args = process.argv.slice(2);
  const result: ParsedArgs = {
    options: {},
    args: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.options.version = true;
    } else if (arg === "--type" || arg === "-t") {
      if (i + 1 < args.length) {
        result.options.type = args[++i];
      }
    } else if (arg === "--user" || arg === "-u") {
      if (i + 1 < args.length) {
        result.options.user = args[++i];
      }
    } else if (arg === "--process" || arg === "-p") {
      if (i + 1 < args.length) {
        result.options.process = args[++i];
      }
    } else if (arg === "--sort" || arg === "-s") {
      if (i + 1 < args.length) {
        const sortValue = args[++i] as SortOption;
        if (["port", "process", "pid", "user"].includes(sortValue)) {
          result.options.sort = sortValue;
        }
      }
    } else if (arg === "--port") {
      // For kill command: --port <number>
      if (i + 1 < args.length) {
        result.options.port = args[++i];
      }
    } else if (arg === "--force" || arg === "-f") {
      result.options.force = true;
    } else if (!arg.startsWith("-")) {
      // This is either a command or a positional argument
      if (!result.command && arg === "kill") {
        result.command = arg;
      } else {
        result.args.push(arg);
      }
    }

    i++;
  }

  return result;
}

async function handleKillCommand(
  portArg: string | undefined,
  force: boolean = false
): Promise<void> {
  if (!portArg) {
    console.error("Error: Port number required");
    console.log("Usage: kipo kill <port>");
    console.log("   or: kipo kill --port <port>");
    process.exit(1);
  }

  const port = parseInt(portArg, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Error: Invalid port number: ${portArg}`);
    console.log("Port must be a number between 1 and 65535");
    process.exit(1);
  }

  const result = await killPortByNumber(port, force);

  if (result.success) {
    console.log(result.message);
    if (result.killed.length > 0) {
      console.log("\nKilled processes:");
      for (const portInfo of result.killed) {
        console.log(`  - PID ${portInfo.pid}: ${portInfo.processName} (port ${portInfo.port})`);
      }
    }
    process.exit(0);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(HELP_TEXT);
}

async function main() {
  const parsed = parseArgs();

  // Handle help
  if (parsed.options.help) {
    showHelp();
    return;
  }

  // Handle version
  if (parsed.options.version) {
    console.log("kipo v0.1.0");
    return;
  }

  // Handle kill command
  if (parsed.command === "kill") {
    const portArg = parsed.args[0] || parsed.options.port;
    await handleKillCommand(portArg, parsed.options.force || false);
    return;
  }

  // Default: Start TUI with optional filters
  const dashboard = new Dashboard({
    type: parsed.options.type,
    user: parsed.options.user,
    process: parsed.options.process,
    sort: parsed.options.sort,
  });

  // Handle cleanup on exit
  process.on("SIGINT", () => {
    dashboard.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    dashboard.stop();
    process.exit(0);
  });

  try {
    await dashboard.start();
  } catch (error) {
    console.error("Failed to start dashboard:", error);
    dashboard.stop();
    process.exit(1);
  }
}

main();
