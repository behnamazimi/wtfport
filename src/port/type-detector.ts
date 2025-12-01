/**
 * Type detection module for ports
 * Determines the type of a port based on port number, command patterns, and process name patterns
 */

import type { PortInfo } from "./types.js";
import type { TypePresetsConfig } from "./type-presets.js";
import { defaultTypePresetsConfig } from "./type-presets.js";

export class TypeDetector {
  private config: TypePresetsConfig;

  constructor(config?: TypePresetsConfig) {
    this.config = config || defaultTypePresetsConfig;
    // Sort presets by priority (highest first) for efficient matching
    this.config.types.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Detect the type of a port based on all available information
   */
  detectType(port: PortInfo): string {
    // Try port number matching first (fastest)
    const portMatch = this.detectByPort(port.port);
    if (portMatch) {
      return portMatch;
    }

    // Try command and process name matching
    const commandMatch = this.detectByCommand(port.command, port.processName);
    if (commandMatch) {
      return commandMatch;
    }

    // Fallback to 'other'
    // Note: detectByCombination is redundant since detectByPort already checked port matches
    return "other";
  }

  /**
   * Detect type by port number
   */
  detectByPort(portNum: number): string | null {
    for (const preset of this.config.types) {
      // Skip 'other' preset for port matching
      if (preset.name === "other") continue;

      // Check exact port matches
      if (preset.ports && preset.ports.includes(portNum)) {
        return preset.name;
      }

      // Check port ranges
      if (preset.portRanges) {
        for (const range of preset.portRanges) {
          if (portNum >= range.min && portNum <= range.max) {
            return preset.name;
          }
        }
      }
    }

    return null;
  }

  /**
   * Detect type by command and process name patterns
   */
  detectByCommand(command: string, processName: string): string | null {
    const searchText = `${command} ${processName}`.toLowerCase();

    for (const preset of this.config.types) {
      // Skip 'other' and 'unexpected' presets for command matching
      if (preset.name === "other" || preset.name === "unexpected") continue;

      // Check command patterns
      if (preset.commandPatterns) {
        for (const pattern of preset.commandPatterns) {
          if (searchText.includes(pattern.toLowerCase())) {
            return preset.name;
          }
        }
      }

      // Check process patterns
      if (preset.processPatterns) {
        for (const pattern of preset.processPatterns) {
          if (searchText.includes(pattern.toLowerCase())) {
            return preset.name;
          }
        }
      }
    }

    return null;
  }
}
