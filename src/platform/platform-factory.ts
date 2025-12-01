/**
 * Platform factory for creating platform-specific adapters
 */

import type { PlatformAdapter } from "./platform-adapter.js";
import { UnixPlatformAdapter } from "./unix-adapter.js";
import { WindowsPlatformAdapter } from "./windows-adapter.js";

/**
 * Get the appropriate platform adapter for the current platform
 */
export function getPlatformAdapter(): PlatformAdapter {
  const platform = process.platform;

  if (platform === "win32") {
    return new WindowsPlatformAdapter();
  } else {
    // macOS (darwin) and Linux
    return new UnixPlatformAdapter();
  }
}
