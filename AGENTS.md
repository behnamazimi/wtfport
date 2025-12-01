# AGENTS.md - Codebase Guide for AI Assistants

This document provides essential information for AI agents working with the wtfport codebase.

## Project Overview

**wtfport** is a cross-platform CLI tool for monitoring and managing network ports. It provides a terminal UI (TUI) for viewing active ports, killing processes, and managing port usage.

## Architecture

### Core Principles

1. **Cross-Platform Support**: The tool must work on macOS, Linux, and Windows
2. **Node.js Runtime**: Code is designed for Node.js runtime
3. **Platform Abstraction**: All platform-specific code is isolated in adapters
4. **Standalone Binaries**: Tool can be distributed as self-contained executables

### Directory Structure

```
src/
├── actions/          # Port actions (kill, restart, copy, etc.)
├── cli.ts           # Main CLI entry point
├── platform/         # Platform abstraction layer
│   ├── platform-adapter.ts    # Interface definition
│   ├── unix-adapter.ts         # macOS/Linux implementation
│   ├── windows-adapter.ts      # Windows implementation
│   └── platform-factory.ts     # Factory for platform detection
├── port/             # Port detection and processing
│   ├── port-detector.ts        # Main port detection class
│   ├── port-processor.ts       # Port categorization and grouping
│   └── types.ts                 # Type definitions
├── tui/              # Terminal UI components
│   ├── dashboard.ts            # Main TUI dashboard
│   ├── keyboard.ts              # Keyboard input handling
│   └── renderer.ts              # ANSI rendering utilities
└── utils/            # Utility functions
    ├── filter-utils.ts         # Port filtering and sorting
    ├── process-utils.ts        # Process management utilities
    └── runtime-utils.ts        # Runtime utilities for Node.js
```

## Key Patterns

### 1. Platform Abstraction

All platform-specific operations go through the `PlatformAdapter` interface:

```typescript
import { getPlatformAdapter } from "./platform/platform-factory.js";

const adapter = getPlatformAdapter();
const ports = await adapter.detectPorts();
await adapter.killProcess(pid, force);
```

**Never** call platform-specific commands (`lsof`, `netstat`, etc.) directly. Always use the platform adapter.

### 2. Runtime Abstraction

For process spawning, use `runtime-utils.ts` functions instead of Node.js `child_process` directly:

```typescript
import { spawnProcess } from "./utils/runtime-utils.js";

// Async
const result = await spawnProcess(["command", "args"], { stdout: "pipe" });

// Sync
```

### 3. Path Handling

**Always** use Node.js `path` module for path operations:

```typescript
import { join, dirname, basename, resolve } from "path";

// ✅ Correct
const filePath = join(dir, "file.txt");
const name = basename(path);

// ❌ Wrong
const filePath = `${dir}/file.txt`;
const name = path.split("/").pop();
```

### 4. Type Safety

The codebase uses TypeScript with strict mode. All types are defined in:

- `src/port/types.ts` - Port-related types
- Platform adapter interfaces in `src/platform/platform-adapter.ts`

## Platform-Specific Details

### Unix (macOS/Linux)

- **Port Detection**: Uses `lsof -i -P -n`
- **Process Info**: Uses `ps` command
- **Process Killing**: Uses `kill` with signals (SIGTERM, SIGKILL)
- **CWD Detection**: Uses `lsof -p <pid> -a -d cwd`

### Windows

- **Port Detection**: Uses `netstat -ano`
- **Process Info**: Uses `tasklist` and `wmic`
- **Process Killing**: Uses `taskkill /PID <pid>`
- **CWD Detection**: Uses `wmic process where ProcessId=<pid> get ExecutablePath`

## Adding New Features

### Adding a New Platform Command

1. Check if it's platform-specific:
   - If yes: Add to the appropriate adapter (`unix-adapter.ts` or `windows-adapter.ts`)
   - If no: Add to shared utilities

2. If platform-specific:

   ```typescript
   // In unix-adapter.ts or windows-adapter.ts
   async newFeature(): Promise<ResultType> {
     // Platform-specific implementation
   }
   ```

3. Add to `PlatformAdapter` interface if it's a core feature

### Adding a New Port Action

1. Add function to `src/actions/port-actions.ts`
2. Use platform adapter for any platform-specific operations
3. Add keyboard shortcut in `src/tui/keyboard.ts` if needed
4. Wire up in `src/tui/dashboard.ts` if it's a TUI action

## Build System

### Development

- **Runtime**: Node.js
- **Command**: `npm run dev` or `node dist/cli.js`

### Production Builds

1. **TypeScript Compilation**: `npm run build:ts`
2. **Binary Creation**: `npm run build:binary:<platform>`
3. **All Platforms**: `npm run build:binary:all`

Binaries are output to `bin/` directory.

### Package Distribution

- **npm**: Uses `package.json` `bin` field
- **Homebrew**: Uses `wtfport.rb` formula
- **Standalone**: Direct binary download from releases

## Testing Considerations

When testing or modifying code:

1. **Platform Detection**: Code automatically detects platform via `process.platform`
2. **Runtime**: Code runs on Node.js only
3. **Error Handling**: All platform operations should have try/catch with fallbacks
4. **Caching**: Port detection uses 1-second cache to avoid excessive system calls

## Common Pitfalls

### ❌ Don't Do This

```typescript
// Direct platform command calls (use runtime-utils instead)
require("child_process").spawn("lsof", ["-i"]);
require("child_process").spawn("netstat", ["-ano"]);

// String-based path manipulation
const path = `${dir}/${file}`;
const name = path.split("/").pop();

// Platform-specific code outside adapters
if (process.platform === "win32") {
  // Windows-specific code
}
```

### ✅ Do This Instead

```typescript
// Use platform adapter
const adapter = getPlatformAdapter();
const ports = await adapter.detectPorts();

// Use path module
import { join, basename } from "path";
const path = join(dir, file);
const name = basename(path);

// Platform-specific code in adapters
// (Already handled by adapter pattern)
```

## File Modification Guidelines

### When Modifying Port Detection

- **Location**: `src/platform/*-adapter.ts`
- **Interface**: Must implement `PlatformAdapter.detectPorts()`
- **Testing**: Test on target platform (macOS, Linux, or Windows)

### When Modifying Process Management

- **Location**: `src/platform/*-adapter.ts` and `src/utils/process-utils.ts`
- **Interface**: Use `PlatformAdapter.killProcess()` and related methods
- **Note**: Process killing differs significantly between Unix (signals) and Windows (taskkill)

### When Modifying TUI

- **Location**: `src/tui/dashboard.ts`, `src/tui/keyboard.ts`, `src/tui/renderer.ts`
- **Note**: TUI is platform-agnostic (uses ANSI codes)
- **Keyboard**: Raw mode handling in `keyboard.ts`

## Dependencies

### Runtime Dependencies

- `minimatch`: Pattern matching for filters

### Development Dependencies

- `typescript`: Type checking and compilation
- `@types/node`: Node.js type definitions
- `pkg`: Binary creation tool

### No External Runtime Required

The tool is designed to work as a standalone binary with no external dependencies (except system commands like `lsof`/`netstat`).

## Code Style

- **Language**: TypeScript with ES modules
- **Imports**: Use `.js` extension in imports (required for ES modules)
- **Async/Await**: Prefer async/await over promises
- **Error Handling**: Use try/catch with specific error messages
- **Type Safety**: Use TypeScript types, avoid `any` when possible

## Important Notes

1. **Shebang**: CLI uses `#!/usr/bin/env node` for Node.js compatibility
2. **Module System**: ES modules (`"type": "module"` in package.json)
3. **Binary Entry**: Binaries use compiled `dist/cli.js` as entry point
4. **Cache**: Port detection caches results for 5 seconds to improve performance

## Questions?

When in doubt:

1. Check the platform adapter interface for available methods
2. Look at existing implementations in `unix-adapter.ts` or `windows-adapter.ts`
3. Use runtime utilities instead of direct Node.js APIs
4. Use path module instead of string manipulation
