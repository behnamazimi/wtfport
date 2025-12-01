import type { PortInfo } from "../port/types.js";
import { killProcess, getProcessLogs } from "../utils/process-utils.js";
import { PortDetector } from "../port/port-detector.js";
import { spawnWithStdin } from "../utils/runtime-utils.js";

/**
 * Kill a port with optional confirmation
 */
export async function killPort(
  portInfo: PortInfo,
  force: boolean = false,
  confirm: boolean = true
): Promise<boolean> {
  if (confirm && !force) {
    // Show confirmation (will be handled by UI)
    return false; // Return false to indicate confirmation needed
  }

  return await killProcess(portInfo.pid, force);
}

/**
 * Copy command to clipboard
 */
export async function copyCommandToClipboard(command: string): Promise<boolean> {
  try {
    // Detect platform and use appropriate command
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS
      const result = await spawnWithStdin(["pbcopy"], command);
      return result.exitCode === 0;
    } else if (platform === "linux") {
      // Linux - try xclip first, then xsel
      try {
        const result = await spawnWithStdin(["xclip", "-selection", "clipboard"], command);
        if (result.exitCode === 0) {
          return true;
        }
      } catch {
        // Try xsel as fallback
        try {
          const result = await spawnWithStdin(["xsel", "--clipboard", "--input"], command);
          return result.exitCode === 0;
        } catch {
          return false;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * View process logs
 */
export async function viewPortLogs(portInfo: PortInfo): Promise<string | null> {
  const logs = await getProcessLogs(portInfo.pid);
  if (!logs) return null;

  return (
    `Process: ${portInfo.processName} (PID: ${portInfo.pid})\n` +
    `Port: ${portInfo.port}\n` +
    `Command: ${portInfo.command}\n\n` +
    `Logs:\n${logs.stdout}\n${logs.stderr}`
  );
}

/**
 * Get full command for a port
 */
export function getFullCommand(portInfo: PortInfo): string {
  return portInfo.command || `Unknown command for PID ${portInfo.pid}`;
}

/**
 * Kill a port by port number
 * Returns true if successful, false otherwise
 */
export async function killPortByNumber(
  port: number,
  force: boolean = false
): Promise<{
  success: boolean;
  killed: PortInfo[];
  message: string;
}> {
  try {
    const detector = new PortDetector();
    const ports = await detector.detectPorts();

    // Find all processes using this port
    const matchingPorts = ports.filter((p) => p.port === port);

    if (matchingPorts.length === 0) {
      return {
        success: false,
        killed: [],
        message: `No process found using port ${port}`,
      };
    }

    // Kill all processes on this port
    const killed: PortInfo[] = [];
    const failed: PortInfo[] = [];

    for (const portInfo of matchingPorts) {
      const result = await killProcess(portInfo.pid, force);
      if (result) {
        killed.push(portInfo);
      } else {
        failed.push(portInfo);
      }
    }

    if (killed.length === 0) {
      return {
        success: false,
        killed: [],
        message: `Failed to kill processes on port ${port}`,
      };
    }

    if (failed.length > 0) {
      return {
        success: true,
        killed,
        message: `Killed ${killed.length} process(es) on port ${port}, but ${failed.length} failed`,
      };
    }

    return {
      success: true,
      killed,
      message: `Successfully killed ${killed.length} process(es) on port ${port}`,
    };
  } catch (error) {
    return {
      success: false,
      killed: [],
      message: `Error killing port ${port}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
