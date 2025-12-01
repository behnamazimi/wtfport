import { getPlatformAdapter } from "../platform/platform-factory.js";

/**
 * Kill a process gracefully (SIGTERM on Unix, normal termination on Windows)
 */
export async function killProcess(pid: number, force: boolean = false): Promise<boolean> {
  try {
    const platformAdapter = getPlatformAdapter();
    return await platformAdapter.killProcess(pid, force);
  } catch {
    return false;
  }
}

/**
 * Get process stdout/stderr streams
 */
export async function getProcessLogs(
  pid: number
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const platformAdapter = getPlatformAdapter();
    const command = await platformAdapter.getProcessCommand(pid);

    return {
      stdout: `Process: ${command}\n\nNote: Live logs are not available. Use the process command to view logs manually.`,
      stderr: "",
    };
  } catch {
    return null;
  }
}
