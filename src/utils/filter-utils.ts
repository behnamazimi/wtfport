import { minimatch } from "minimatch";
import type { PortInfo, PortGroup } from "../port/types.js";
import { PortProcessor } from "../port/port-processor.js";

export type SortOption = "port" | "process" | "pid" | "user";

/**
 * Filter ports by type using minimatch patterns
 */
export function filterByType(
  ports: PortInfo[],
  pattern: string,
  processor: PortProcessor
): PortInfo[] {
  return ports.filter((port) => {
    // Categorize the port to get its type
    const category = processor.categorizePort(port);
    return minimatch(category, pattern);
  });
}

/**
 * Filter ports by username using minimatch patterns
 */
export function filterByUser(ports: PortInfo[], pattern: string): PortInfo[] {
  return ports.filter((port) => minimatch(port.user, pattern));
}

/**
 * Filter ports by process name using minimatch patterns
 */
export function filterByProcess(ports: PortInfo[], pattern: string): PortInfo[] {
  return ports.filter(
    (port) => minimatch(port.processName, pattern) || minimatch(port.command, pattern)
  );
}

/**
 * Sort ports by the specified option
 */
export function sortPorts(ports: PortInfo[], sortBy: SortOption): PortInfo[] {
  const sorted = [...ports];

  switch (sortBy) {
    case "port":
      sorted.sort((a, b) => a.port - b.port);
      break;
    case "process":
      sorted.sort((a, b) => a.processName.localeCompare(b.processName));
      break;
    case "pid":
      sorted.sort((a, b) => a.pid - b.pid);
      break;
    case "user":
      sorted.sort((a, b) => a.user.localeCompare(b.user));
      break;
  }

  return sorted;
}

/**
 * Apply filters to port groups
 */
export function applyFiltersToGroups(
  groups: PortGroup[],
  options: {
    type?: string;
    user?: string;
    process?: string;
    sort?: SortOption;
  },
  processor: PortProcessor
): PortGroup[] {
  const filteredGroups: PortGroup[] = [];

  for (const group of groups) {
    // Filter ports within the group
    let filteredPorts = [...group.ports];

    if (options.type) {
      // Check if group type matches pattern
      if (!minimatch(group.type, options.type)) {
        // Filter ports by type if group type doesn't match
        filteredPorts = filterByType(filteredPorts, options.type, processor);
        if (filteredPorts.length === 0) continue;
      }
    }

    if (options.user) {
      filteredPorts = filterByUser(filteredPorts, options.user);
      if (filteredPorts.length === 0) continue;
    }

    if (options.process) {
      filteredPorts = filterByProcess(filteredPorts, options.process);
      if (filteredPorts.length === 0) continue;
    }

    if (options.sort) {
      filteredPorts = sortPorts(filteredPorts, options.sort);
    }

    // Only include group if it has ports after filtering
    if (filteredPorts.length > 0) {
      filteredGroups.push({
        ...group,
        ports: filteredPorts,
      });
    }
  }

  return filteredGroups;
}
