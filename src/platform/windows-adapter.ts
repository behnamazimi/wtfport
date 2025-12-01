/**
 * Windows platform adapter
 * Uses netstat, tasklist, and taskkill commands
 */

import type { PlatformAdapter } from "./platform-adapter.js";
import type { PortInfo } from "../port/types.js";
import { spawnProcess } from "../utils/runtime-utils.js";
import { dirname } from "path";
import { logger } from "../utils/logger.js";
import { CacheManager } from "./cache-manager.js";

interface ProcessInfo {
  command: string;
  cwd: string | null;
  lifetime?: number;
}

export class WindowsPlatformAdapter implements PlatformAdapter {
  // Process-level cache with 30-second TTL (matching Unix adapter)
  private processInfoCache: CacheManager<ProcessInfo> = new CacheManager<ProcessInfo>(30000, 1000);
  /**
   * Detect all active listening ports using netstat
   */
  async detectPorts(): Promise<PortInfo[]> {
    try {
      // Use netstat to get port information
      // netstat -ano shows: Proto, Local Address, Foreign Address, State, PID
      const result = await spawnProcess(["netstat", "-ano"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `netstat failed with exit code ${result.exitCode}: ${result.stderr || "No error message"}`
        );
      }

      const ports = this.parseNetstatOutput(result.stdout);

      // Batch fetch process info for all unique PIDs (similar to Unix adapter)
      const uniquePids = Array.from(new Set(ports.map((p) => p.pid)));
      const batchProcessInfo = await this.getBatchProcessInfo(uniquePids);

      // Map process info back to ports
      return ports.map((port) => {
        const processInfo = batchProcessInfo.get(port.pid);
        if (processInfo) {
          return {
            ...port,
            command: processInfo.command,
            cwd: processInfo.cwd,
            lifetime: processInfo.lifetime,
          };
        }
        return port;
      });
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to execute netstat: ${error}`);
    }
  }

  /**
   * Parse netstat output into PortInfo objects
   */
  private parseNetstatOutput(output: string): PortInfo[] {
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.trim());
    const ports: PortInfo[] = [];

    for (const line of lines) {
      // Skip header lines
      if (line.startsWith("Active") || line.startsWith("Proto") || line.startsWith("  Proto")) {
        continue;
      }

      // Parse line: TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const protocol = parts[0].toUpperCase();
      if (protocol !== "TCP" && protocol !== "UDP") continue;

      // Only process LISTENING connections
      if (parts[parts.length - 1] !== "LISTENING") continue;

      // Parse local address: 0.0.0.0:3000 or [::]:3000
      const localAddr = parts[1];
      const addrMatch = localAddr.match(/:(\d+)$/);
      if (!addrMatch) continue;

      const port = parseInt(addrMatch[1], 10);
      const pid = parseInt(parts[parts.length - 1], 10);

      if (isNaN(port) || isNaN(pid)) continue;

      ports.push({
        port,
        protocol: protocol as "TCP" | "UDP",
        pid,
        processName: "", // Will be filled by getProcessInfo
        command: "", // Will be filled by getProcessInfo
        cwd: null, // Will be filled by getProcessInfo
        user: "", // Windows doesn't easily provide user info
        lifetime: undefined, // Will be filled by getProcessLifetime
      });
    }

    // Deduplicate by port+pid
    const seen = new Map<string, PortInfo>();
    for (const port of ports) {
      const key = `${port.port}-${port.pid}`;
      if (!seen.has(key)) {
        seen.set(key, port);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Get batch process information for multiple PIDs using single wmic/tasklist calls
   */
  private async getBatchProcessInfo(pids: number[]): Promise<Map<number, ProcessInfo>> {
    // Cleanup cache before checking (lazy cleanup)
    this.processInfoCache.cleanup();

    const result = new Map<number, ProcessInfo>();
    const uncachedPids: number[] = [];

    // Check cache first
    for (const pid of pids) {
      const cached = this.processInfoCache.get(pid);
      if (cached) {
        result.set(pid, cached);
      } else {
        uncachedPids.push(pid);
      }
    }

    // If all PIDs are cached, return early
    if (uncachedPids.length === 0) {
      return result;
    }

    // Batch fetch process info, CWD, and lifetime
    const [processInfoMap, cwdMap, lifetimeMap] = await Promise.all([
      this.getBatchProcessInfoFromWmic(uncachedPids),
      this.getBatchProcessCWD(uncachedPids),
      this.getBatchProcessLifetime(uncachedPids),
    ]);

    // Combine results and update cache
    for (const pid of uncachedPids) {
      const info: ProcessInfo = {
        command: processInfoMap.get(pid)?.command || "unknown",
        cwd: cwdMap.get(pid) || null,
        lifetime: lifetimeMap.get(pid),
      };
      result.set(pid, info);
      this.processInfoCache.set(pid, info);
    }

    return result;
  }

  /**
   * Get batch process info (command) from wmic for multiple PIDs
   */
  private async getBatchProcessInfoFromWmic(
    pids: number[]
  ): Promise<Map<number, { command: string }>> {
    const result = new Map<number, { command: string }>();

    if (pids.length === 0) return result;

    try {
      // Build WHERE clause for multiple PIDs: ProcessId=123 OR ProcessId=456 OR ...
      const whereClause = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");

      const proc = await spawnProcess(
        [
          "wmic",
          "process",
          "where",
          `(${whereClause})`,
          "get",
          "ProcessId,CommandLine",
          "/format:list",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      if (proc.exitCode !== 0) {
        logger.error(
          `wmic failed with exit code ${proc.exitCode}: ${proc.stderr || "No error message"}`
        );
        // Fallback: set unknown for all PIDs
        for (const pid of pids) {
          result.set(pid, { command: "unknown" });
        }
        return result;
      }

      // Parse output: format is "ProcessId=123\nCommandLine=...\n\n" for each process
      const output = proc.stdout;
      const lines = output.split("\n");
      let currentPid: number | null = null;

      for (const line of lines) {
        if (line.startsWith("ProcessId=")) {
          currentPid = parseInt(line.substring("ProcessId=".length).trim(), 10);
        } else if (line.startsWith("CommandLine=") && currentPid !== null) {
          const command = line.substring("CommandLine=".length).trim();
          result.set(currentPid, { command: command || "unknown" });
          currentPid = null;
        }
      }

      // Fallback for PIDs not found in output
      for (const pid of pids) {
        if (!result.has(pid)) {
          result.set(pid, { command: "unknown" });
        }
      }
    } catch (error) {
      logger.error(`Error fetching batch process info for PIDs:`, error);
      // Fallback: set unknown for all PIDs
      for (const pid of pids) {
        result.set(pid, { command: "unknown" });
      }
    }

    return result;
  }

  /**
   * Get batch CWD for multiple PIDs using single wmic command
   */
  private async getBatchProcessCWD(pids: number[]): Promise<Map<number, string | null>> {
    const result = new Map<number, string | null>();

    if (pids.length === 0) return result;

    try {
      // Build WHERE clause for multiple PIDs
      const whereClause = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");

      const proc = await spawnProcess(
        [
          "wmic",
          "process",
          "where",
          `(${whereClause})`,
          "get",
          "ProcessId,ExecutablePath",
          "/format:list",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      if (proc.exitCode !== 0) {
        // Ignore CWD errors - return empty map
        return result;
      }

      // Parse output: format is "ProcessId=123\nExecutablePath=...\n\n" for each process
      const output = proc.stdout;
      const lines = output.split("\n");
      let currentPid: number | null = null;

      for (const line of lines) {
        if (line.startsWith("ProcessId=")) {
          currentPid = parseInt(line.substring("ProcessId=".length).trim(), 10);
        } else if (line.startsWith("ExecutablePath=") && currentPid !== null) {
          const exePath = line.substring("ExecutablePath=".length).trim();
          if (exePath) {
            result.set(currentPid, dirname(exePath));
          } else {
            result.set(currentPid, null);
          }
          currentPid = null;
        }
      }
    } catch {
      // Ignore CWD errors - return empty map
    }

    return result;
  }

  /**
   * Get batch process lifetime for multiple PIDs using single wmic command
   */
  private async getBatchProcessLifetime(pids: number[]): Promise<Map<number, number | undefined>> {
    const result = new Map<number, number | undefined>();

    if (pids.length === 0) return result;

    try {
      // Build WHERE clause for multiple PIDs
      const whereClause = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");

      const proc = await spawnProcess(
        [
          "wmic",
          "process",
          "where",
          `(${whereClause})`,
          "get",
          "ProcessId,CreationDate",
          "/format:list",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      if (proc.exitCode !== 0) {
        // Ignore lifetime errors - return empty map
        return result;
      }

      // Parse output: format is "ProcessId=123\nCreationDate=...\n\n" for each process
      const output = proc.stdout;
      const lines = output.split("\n");
      let currentPid: number | null = null;

      for (const line of lines) {
        if (line.startsWith("ProcessId=")) {
          currentPid = parseInt(line.substring("ProcessId=".length).trim(), 10);
        } else if (line.startsWith("CreationDate=") && currentPid !== null) {
          const dateStr = line.substring("CreationDate=".length).trim();
          const lifetime = this.parseCreationDate(dateStr);
          result.set(currentPid, lifetime);
          currentPid = null;
        }
      }
    } catch {
      // Ignore lifetime errors - return empty map
    }

    return result;
  }

  /**
   * Parse Windows creation date format: YYYYMMDDHHmmss.microseconds+timezone
   */
  private parseCreationDate(dateStr: string): number | undefined {
    if (!dateStr || dateStr.length < 14) return undefined;

    try {
      const year = parseInt(dateStr.substring(0, 4), 10);
      const month = parseInt(dateStr.substring(4, 6), 10) - 1; // Month is 0-indexed
      const day = parseInt(dateStr.substring(6, 8), 10);
      const hour = parseInt(dateStr.substring(8, 10), 10);
      const minute = parseInt(dateStr.substring(10, 12), 10);
      const second = parseInt(dateStr.substring(12, 14), 10);

      const creationDate = new Date(year, month, day, hour, minute, second);
      const now = new Date();
      const diffSeconds = Math.floor((now.getTime() - creationDate.getTime()) / 1000);

      return diffSeconds > 0 ? diffSeconds : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get process information using tasklist (single PID - uses cache and batch methods)
   */
  async getProcessInfo(pid: number): Promise<{
    command: string;
    cwd: string | null;
  }> {
    // Check cache first
    const cached = this.processInfoCache.get(pid);
    if (cached) {
      return {
        command: cached.command,
        cwd: cached.cwd,
      };
    }

    // Fetch if not cached
    const batchInfo = await this.getBatchProcessInfo([pid]);
    const info = batchInfo.get(pid);

    if (info) {
      return {
        command: info.command,
        cwd: info.cwd,
      };
    }

    return {
      command: "unknown",
      cwd: null,
    };
  }

  /**
   * Get process lifetime (uses cache and batch methods)
   */
  async getProcessLifetime(pid: number): Promise<number | undefined> {
    // Check cache first
    const cached = this.processInfoCache.get(pid);
    if (cached) {
      return cached.lifetime;
    }

    // Fetch if not cached
    const batchInfo = await this.getBatchProcessInfo([pid]);
    const info = batchInfo.get(pid);
    return info?.lifetime;
  }

  /**
   * Kill a process using taskkill (with retry logic similar to Unix)
   */
  async killProcess(pid: number, force: boolean): Promise<boolean> {
    try {
      let killed = false;

      if (force) {
        // Force kill immediately
        const proc = await spawnProcess(["taskkill", "/F", "/PID", pid.toString()], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if (proc.exitCode !== 0 && proc.stderr) {
          logger.error(`Failed to force kill process ${pid}: ${proc.stderr}`);
        }
        killed = proc.exitCode === 0;
      } else {
        // Try graceful shutdown first
        const proc = await spawnProcess(["taskkill", "/PID", pid.toString()], {
          stdout: "pipe",
          stderr: "pipe",
        });

        if (proc.exitCode !== 0) {
          if (proc.stderr) {
            logger.error(`Failed to kill process ${pid}: ${proc.stderr}`);
          }
          return false;
        }

        // Wait and check if process still exists
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const checkProc = await spawnProcess(
          ["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
          {
            stdout: "pipe",
            stderr: "pipe",
          }
        );

        if (checkProc.exitCode === 0 && checkProc.stdout.trim()) {
          // Process still alive, force kill
          const forceProc = await spawnProcess(["taskkill", "/F", "/PID", pid.toString()], {
            stdout: "pipe",
            stderr: "pipe",
          });
          if (forceProc.exitCode !== 0 && forceProc.stderr) {
            logger.error(`Failed to force kill process ${pid}: ${forceProc.stderr}`);
          }
          killed = forceProc.exitCode === 0;
        } else {
          killed = true;
        }
      }

      // Invalidate cache for killed process
      if (killed) {
        this.invalidateProcessCache(pid);
      }

      return killed;
    } catch (error) {
      // Invalidate cache even on error (process might have been killed)
      this.invalidateProcessCache(pid);
      logger.error(`Error killing process ${pid}:`, error);
      return false;
    }
  }

  /**
   * Invalidate process cache for a specific PID
   */
  invalidateProcessCache(pid: number): void {
    this.processInfoCache.delete(pid);
  }

  /**
   * Get process command line using wmic (uses cache and batch methods)
   */
  async getProcessCommand(pid: number): Promise<string> {
    try {
      const batchInfo = await this.getBatchProcessInfo([pid]);
      const info = batchInfo.get(pid);
      return info?.command || "unknown";
    } catch {
      return "unknown";
    }
  }
}
