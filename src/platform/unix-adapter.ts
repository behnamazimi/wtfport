/**
 * Unix platform adapter (macOS and Linux)
 * Uses lsof and ps commands
 */

import type { PlatformAdapter } from "./platform-adapter.js";
import type { PortInfo } from "../port/types.js";
import { spawnProcess } from "../utils/runtime-utils.js";
import { logger } from "../utils/logger.js";
import { CacheManager } from "./cache-manager.js";

interface ProcessInfo {
  command: string;
  cwd: string | null;
  lifetime?: number;
}

export class UnixPlatformAdapter implements PlatformAdapter {
  // Process-level cache with 30-second TTL
  private processInfoCache: CacheManager<ProcessInfo> = new CacheManager<ProcessInfo>(30000, 1000);
  /**
   * Detect all active listening ports using lsof
   */
  async detectPorts(): Promise<PortInfo[]> {
    try {
      const result = await spawnProcess(["lsof", "-i", "-P", "-n"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        if (result.stderr.includes("Permission denied")) {
          throw new Error("Permission denied. Some ports may require sudo access.");
        }
        throw new Error(
          `lsof failed with exit code ${result.exitCode}: ${result.stderr || "No error message"}`
        );
      }

      return await this.parseLsofOutput(result.stdout);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to execute lsof: ${error}`);
    }
  }

  /**
   * Parse lsof output into PortInfo objects
   */
  private async parseLsofOutput(output: string): Promise<PortInfo[]> {
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.trim());
    const ports: PortInfo[] = [];
    const uniquePids = new Set<number>();

    for (const line of lines) {
      // Skip header line
      if (line.startsWith("COMMAND")) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;

      const command = parts[0];
      const pid = parseInt(parts[1], 10);
      const user = parts[2];
      const type = parts[4];
      const name = parts.slice(8).join(" ");

      // Only process listening sockets
      if (type !== "IPv4" && type !== "IPv6") continue;
      // LISTEN status is in parentheses in the NAME field
      if (!name.includes("(LISTEN)")) continue;

      // Parse NAME field: hostname:port or *:port
      const nameMatch = name.match(/(\*|[\w.]+):(\d+)/);
      if (!nameMatch) continue;

      const port = parseInt(nameMatch[2], 10);
      const protocol: "TCP" | "UDP" = name.includes("UDP") ? "UDP" : "TCP";

      ports.push({
        port,
        protocol,
        pid,
        processName: command,
        command: "", // Will be filled by batch process info
        cwd: null, // Will be filled by batch process info
        user,
        lifetime: undefined, // Will be filled by batch process info
      });

      uniquePids.add(pid);
    }

    // Batch fetch process info for all unique PIDs
    const pidsArray = Array.from(uniquePids);
    const batchProcessInfo = await this.getBatchProcessInfo(pidsArray);

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
  }

  /**
   * Get batch process information for multiple PIDs using single ps command
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

    // Batch fetch process info and CWD
    const [processInfoMap, cwdMap] = await Promise.all([
      this.getBatchProcessInfoFromPs(uncachedPids),
      this.getBatchProcessCWD(uncachedPids),
    ]);

    // Combine results and update cache
    for (const pid of uncachedPids) {
      const info: ProcessInfo = {
        command: processInfoMap.get(pid)?.command || "unknown",
        cwd: cwdMap.get(pid) || null,
        lifetime: processInfoMap.get(pid)?.lifetime,
      };
      result.set(pid, info);
      this.processInfoCache.set(pid, info);
    }

    return result;
  }

  /**
   * Get batch process info (command and lifetime) from ps command
   */
  private async getBatchProcessInfoFromPs(
    pids: number[]
  ): Promise<Map<number, { command: string; lifetime?: number }>> {
    const result = new Map<number, { command: string; lifetime?: number }>();

    if (pids.length === 0) return result;

    try {
      // Use single ps command with comma-separated PIDs (async)
      const pidList = pids.join(",");
      const proc = await spawnProcess(["ps", "-p", pidList, "-o", "pid=,command=,etime=", "-ww"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = proc.stdout;

      // Parse output: each line is "pid command etime"
      // Note: etime format is [[dd-]hh:]mm:ss, so we can identify it by the pattern
      const lines = output.trim().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Find first space to separate PID from command
        const firstSpace = trimmed.indexOf(" ");
        if (firstSpace === -1) continue;

        const pid = parseInt(trimmed.substring(0, firstSpace), 10);
        if (isNaN(pid)) continue;

        // Find etime pattern: look for time pattern at the end
        // Etime formats: dd-hh:mm:ss, hh:mm:ss, or mm:ss
        // Match from the end to avoid matching times in the command itself
        const etimePatterns = [
          /(\d{1,2}-\d{1,2}:\d{2}:\d{2})$/, // dd-hh:mm:ss
          /(\d{1,2}:\d{2}:\d{2})$/, // hh:mm:ss (must have 2 colons)
          /(\d{1,2}:\d{2})$/, // mm:ss (only 1 colon, must be at end)
        ];

        let etimeMatch: RegExpMatchArray | null = null;
        for (const pattern of etimePatterns) {
          const match = trimmed.match(pattern);
          if (match) {
            etimeMatch = match;
            break;
          }
        }

        if (etimeMatch) {
          // Has etime - extract command (everything between first space and etime)
          const etimeStr = etimeMatch[1];
          const etimeStart = trimmed.lastIndexOf(etimeStr);
          const command = trimmed.substring(firstSpace + 1, etimeStart).trim();
          const lifetime = this.parseEtime(etimeStr);
          result.set(pid, { command: command || "unknown", lifetime });
        } else {
          // No etime, just command (everything after first space)
          const command = trimmed.substring(firstSpace + 1).trim();
          result.set(pid, { command: command || "unknown" });
        }
      }
    } catch {
      // Fallback: set unknown for all PIDs
      for (const pid of pids) {
        result.set(pid, { command: "unknown" });
      }
    }

    return result;
  }

  /**
   * Get batch CWD for multiple PIDs using single lsof command
   */
  private async getBatchProcessCWD(pids: number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>();

    if (pids.length === 0) return result;

    try {
      // Use single lsof command with comma-separated PIDs (async)
      const pidList = pids.join(",");
      const proc = await spawnProcess(["lsof", "-p", pidList, "-a", "-d", "cwd", "-Fn"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = proc.stdout;

      // Parse output: format is "p<pid>\nn<path>" for each process
      const lines = output.split("\n");
      let currentPid: number | null = null;

      for (const line of lines) {
        if (line.startsWith("p")) {
          // PID line
          const pidStr = line.substring(1);
          currentPid = parseInt(pidStr, 10);
        } else if (line.startsWith("n") && currentPid !== null) {
          // Path line
          const path = line.substring(1);
          result.set(currentPid, path);
          currentPid = null;
        }
      }
    } catch {
      // Ignore CWD errors - return empty map
    }

    return result;
  }

  /**
   * Parse etime format: [[dd-]hh:]mm:ss
   */
  private parseEtime(etimeStr: string): number | undefined {
    if (!etimeStr) return undefined;

    const parts = etimeStr.split(/[:-]/);
    let totalSeconds = 0;

    if (parts.length === 4) {
      // Format: dd-hh:mm:ss
      const days = parseInt(parts[0], 10) || 0;
      const hours = parseInt(parts[1], 10) || 0;
      const minutes = parseInt(parts[2], 10) || 0;
      const seconds = parseInt(parts[3], 10) || 0;
      totalSeconds = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 3) {
      // Format: hh:mm:ss
      const hours = parseInt(parts[0], 10) || 0;
      const minutes = parseInt(parts[1], 10) || 0;
      const seconds = parseInt(parts[2], 10) || 0;
      totalSeconds = hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      // Format: mm:ss
      const minutes = parseInt(parts[0], 10) || 0;
      const seconds = parseInt(parts[1], 10) || 0;
      totalSeconds = minutes * 60 + seconds;
    }

    return totalSeconds > 0 ? totalSeconds : undefined;
  }

  /**
   * Get process information (single PID - uses cache and batch methods)
   */
  async getProcessInfo(pid: number): Promise<{
    command: string;
    cwd: string | null;
  }> {
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
   * Kill a process (async for consistency with other methods)
   */
  async killProcess(pid: number, force: boolean): Promise<boolean> {
    try {
      let killed = false;

      if (force) {
        const proc = await spawnProcess(["kill", "-9", pid.toString()], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if (proc.exitCode !== 0 && proc.stderr) {
          logger.error(`Failed to kill process ${pid}: ${proc.stderr}`);
        }
        killed = proc.exitCode === 0;
      } else {
        // Try graceful shutdown first
        const proc = await spawnProcess(["kill", "-TERM", pid.toString()], {
          stdout: "pipe",
          stderr: "pipe",
        });

        if (proc.exitCode !== 0) {
          if (proc.stderr) {
            logger.error(`Failed to send SIGTERM to process ${pid}: ${proc.stderr}`);
          }
          return false;
        }

        // Wait and check if process still exists
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const checkProc = await spawnProcess(["ps", "-p", pid.toString()], {
          stdout: "pipe",
          stderr: "pipe",
        });

        if (checkProc.exitCode === 0) {
          // Process still alive, force kill
          const forceProc = await spawnProcess(["kill", "-9", pid.toString()], {
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
   * Get process command line (full command, not truncated)
   */
  async getProcessCommand(pid: number): Promise<string> {
    try {
      // Use ps with -ww flag for unlimited width to get full command
      const proc = await spawnProcess(["ps", "-p", pid.toString(), "-o", "command=", "-ww"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (proc.exitCode === 0 && proc.stdout.trim()) {
        return proc.stdout.trim();
      }

      // Fallback to batch method
      const batchInfo = await this.getBatchProcessInfo([pid]);
      const info = batchInfo.get(pid);
      return info?.command || "unknown";
    } catch {
      return "unknown";
    }
  }
}
