/**
 * Statistics tracking and persistence for port kills
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { PortInfo } from "../port/types.js";
import type { KillStats } from "./types.js";

const STATS_DIR = join(homedir(), ".kipo");
const STATS_FILE = join(STATS_DIR, "stats.json");

/**
 * Get default stats structure
 */
function getDefaultStats(): KillStats {
  return {
    totalKills: 0,
    killsByType: {},
    firstKillTimestamp: null,
    lastKillTimestamp: null,
    mostKilledPort: null,
    mostKilledPortCount: 0,
    forceKills: 0,
  };
}

/**
 * Load stats from file
 */
export function loadStats(): KillStats {
  try {
    if (!existsSync(STATS_FILE)) {
      return getDefaultStats();
    }

    const content = readFileSync(STATS_FILE, "utf-8");
    const stats = JSON.parse(content) as KillStats;

    // Ensure all required fields exist
    return {
      ...getDefaultStats(),
      ...stats,
    };
  } catch (error) {
    // If file is corrupted or can't be read, return default
    return getDefaultStats();
  }
}

/**
 * Save stats to file
 */
export function saveStats(stats: KillStats): void {
  try {
    // Ensure directory exists
    if (!existsSync(STATS_DIR)) {
      mkdirSync(STATS_DIR, { recursive: true });
    }

    // Write stats to file
    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
  } catch (error) {
    // Silently fail - stats are not critical
    // Could log to logger if needed
  }
}

/**
 * Record a kill in statistics
 */
export function recordKill(portInfo: PortInfo, force: boolean = false): KillStats {
  const stats = loadStats();

  // Update total kills
  stats.totalKills += 1;

  // Update kills by type
  const type = portInfo.type || "other";
  stats.killsByType[type] = (stats.killsByType[type] || 0) + 1;

  // Update timestamps
  const now = Date.now();
  if (!stats.firstKillTimestamp) {
    stats.firstKillTimestamp = now;
  }
  stats.lastKillTimestamp = now;

  // Track most killed port (separate from type tracking)
  const portKey = `port:${portInfo.port}`;
  const portCount = (stats.killsByType[portKey] || 0) + 1;
  stats.killsByType[portKey] = portCount;
  if (portCount > stats.mostKilledPortCount) {
    stats.mostKilledPort = portInfo.port;
    stats.mostKilledPortCount = portCount;
  }

  // Track force kills
  if (force) {
    stats.forceKills += 1;
  }

  // Save updated stats
  saveStats(stats);

  return stats;
}

/**
 * Get formatted stats summary
 */
export function getStatsSummary(stats: KillStats): string {
  const lines: string[] = [];
  lines.push(`Total Kills: ${stats.totalKills}`);

  if (stats.mostKilledPort) {
    lines.push(`Most Killed Port: ${stats.mostKilledPort} (${stats.mostKilledPortCount} times)`);
  }

  if (stats.forceKills > 0) {
    lines.push(`Force Kills: ${stats.forceKills}`);
  }

  if (Object.keys(stats.killsByType).length > 0) {
    lines.push("\nKills by Type:");
    const typeKills = Object.entries(stats.killsByType)
      .filter(([key]) => !key.startsWith("port:"))
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    for (const [type, count] of typeKills) {
      lines.push(`  ${type}: ${count}`);
    }
  }

  return lines.join("\n");
}
