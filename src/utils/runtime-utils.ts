/**
 * Runtime utilities for Node.js
 * Provides process spawning utilities for Node.js runtime
 */

import { createRequire } from "module";

// Lazy-load Node.js modules using createRequire for ES modules
type ChildProcessModule = typeof import("child_process");
let nodeChildProcess: ChildProcessModule | null = null;
let nodeRequire: ReturnType<typeof createRequire> | null = null;

/**
 * Simple concurrency limiter
 */
class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.running++;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.running--;
          if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
          }
        }
      };

      if (this.running < this.limit) {
        execute();
      } else {
        this.queue.push(execute);
      }
    });
  }
}

// Global concurrency limiter for process spawning (max 10 concurrent processes)
const processLimiter = new ConcurrencyLimiter(10);

function getNodeRequire() {
  if (!nodeRequire) {
    // In bundled CommonJS, require is available directly
    // In ES modules, use createRequire
    if (typeof require !== "undefined") {
      // CommonJS mode (bundled binary)
      nodeRequire = require;
    } else {
      // ES module mode - use createRequire
      // Use a try-catch to handle cases where import.meta might not be available
      // (e.g., in some bundling scenarios)
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const metaUrl = (import.meta as { url?: string }).url;
        if (metaUrl) {
          nodeRequire = createRequire(metaUrl);
        } else {
          throw new Error("import.meta.url is not available");
        }
      } catch {
        // Fallback: this should rarely happen, but provides a safety net
        throw new Error("Cannot create require: neither require nor import.meta.url is available");
      }
    }
  }
  return nodeRequire;
}

function getNodeChildProcessSync() {
  if (!nodeChildProcess) {
    const requireFn = getNodeRequire();
    nodeChildProcess = requireFn("child_process");
  }
  return nodeChildProcess;
}

/**
 * Spawn a process (async) with concurrency limiting
 * Uses Node.js child_process
 */
export async function spawnProcess(
  command: string[],
  options: {
    stdin?: "pipe" | "ignore";
    stdout?: "pipe" | "ignore";
    stderr?: "pipe" | "ignore";
    cwd?: string;
    detached?: boolean;
    stdio?: ("pipe" | "ignore")[];
  } = {}
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return processLimiter.run(async () => {
    // Use Node.js child_process
    const childProcess = getNodeChildProcessSync();
    if (!childProcess) {
      throw new Error("Failed to load child_process module");
    }
    const { spawn } = childProcess;

    return new Promise((resolve, reject) => {
      const proc = spawn(command[0], command.slice(1), {
        cwd: options.cwd,
        detached: options.detached,
        stdio: options.stdio || [
          options.stdin || "pipe",
          options.stdout || "pipe",
          options.stderr || "pipe",
        ],
      });

      let stdout = "";
      let stderr = "";

      if (proc.stdout) {
        proc.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
      }

      proc.on("close", (code: number | null) => {
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
        });
      });

      proc.on("error", (error: Error) => {
        reject(error);
      });
    });
  });
}

/**
 * Spawn a process with stdin pipe (for interactive processes)
 */
export async function spawnWithStdin(
  command: string[],
  input: string,
  options: {
    cwd?: string;
  } = {}
): Promise<{
  exitCode: number;
}> {
  // Use sync version since require is synchronous
  const childProcess = getNodeChildProcessSync();
  if (!childProcess) {
    throw new Error("Failed to load child_process module");
  }
  const { spawn } = childProcess;

  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin?.write(input);
    proc.stdin?.end();

    proc.on("close", (code: number | null) => {
      resolve({
        exitCode: code || 0,
      });
    });

    proc.on("error", (error: Error) => {
      reject(error);
    });
  });
}
