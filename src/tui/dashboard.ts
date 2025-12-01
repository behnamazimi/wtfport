import { PortDetector } from "../port/port-detector.js";
import { PortProcessor } from "../port/port-processor.js";
import { KeyboardHandler } from "./keyboard.js";
import {
  ANSIRenderer,
  Colors,
  Styles,
  Backgrounds,
  getCategoryColor,
  truncate,
  pad,
  type ANSIColor,
} from "./renderer.js";
import type { PortInfo, PortGroup } from "../port/types.js";
import {
  killPort,
  copyCommandToClipboard,
  viewPortLogs,
  getFullCommand,
} from "../actions/port-actions.js";
import { applyFiltersToGroups, type SortOption } from "../utils/filter-utils.js";
import { getPlatformAdapter } from "../platform/platform-factory.js";
import { logger } from "../utils/logger.js";
import { setupKeyboardHandlers, type DashboardHandlers } from "./dashboard-handlers.js";
import { getCurrentRank, formatRank } from "../gamification/killer-ranks.js";
import { loadStats } from "../gamification/stats.js";

export interface DashboardState {
  ports: PortInfo[];
  groups: PortGroup[];
  selectedIndex: number;
  selectedGroupIndex: number;
  filter: string;
  filterMode: "port" | "process" | "user" | "all";
  showHelp: boolean;
  showConfirm: boolean;
  confirmAction: (() => Promise<void>) | null;
  confirmMessage: string;
  showLogs: boolean;
  logsContent: string | null;
  showCommand: boolean;
  commandContent: string | null;
  refreshInterval: number;
  lastUpdate: number;
  sortBy: "port" | "process" | "pid";
  quickKill: boolean;
  showDetails: boolean;
  searching: boolean; // Port search mode (like lsof -i :PORT)
  isKilling: boolean; // Loading state while killing
  killingPort: number | null; // Port being killed
  // Gamification state
  killMessage: { message: string; emoji?: string; color?: string } | null;
  killMessageExpiresAt: number | null;
  showStats: boolean;
  statsContent: string | null;
  currentRank: string | null;
}

export class Dashboard {
  private detector: PortDetector;
  private processor: PortProcessor;
  private renderer: ANSIRenderer;
  private keyboard: KeyboardHandler;
  private state: DashboardState;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;
  private searchBuffer: string = "";

  // Memoization cache for filtered ports
  private filteredPortsCache: {
    result: Array<{ port: PortInfo; group: PortGroup }>;
    filter: string;
    groupsHash: string;
    sortBy: string;
  } | null = null;

  // Delta rendering: track previous render state
  private previousRenderState: {
    filteredPorts: Array<{ port: PortInfo; group: PortGroup }>;
    selectedIndex: number;
    filter: string;
    sortBy: string;
    showDetails: boolean;
  } | null = null;


  // Filter options from CLI
  private readonly filterOptions: {
    type?: string;
    user?: string;
    process?: string;
    sort?: SortOption;
  };

  constructor(options?: { type?: string; user?: string; process?: string; sort?: SortOption }) {
    this.detector = new PortDetector();
    this.processor = new PortProcessor();
    this.renderer = new ANSIRenderer();
    this.keyboard = new KeyboardHandler();
    this.filterOptions = options || {};

    this.state = {
      ports: [],
      groups: [],
      selectedIndex: 0,
      selectedGroupIndex: 0,
      filter: "",
      filterMode: "all",
      showHelp: false,
      showConfirm: false,
      confirmAction: null,
      confirmMessage: "",
      showLogs: false,
      logsContent: null,
      showCommand: false,
      commandContent: null,
      refreshInterval: 2000,
      lastUpdate: 0,
      sortBy: "port",
      quickKill: false,
      showDetails: true,
      searching: false,
      isKilling: false,
      killingPort: null,
      killMessage: null,
      killMessageExpiresAt: null,
      showStats: false,
      statsContent: null,
      currentRank: null,
    };
  }

  /**
   * Start the dashboard
   */
  async start(): Promise<void> {
    this.isRunning = true;

    // Load initial stats and rank
    const stats = loadStats();
    const rank = getCurrentRank(stats.totalKills);
    this.state.currentRank = formatRank(rank);

    // Setup keyboard handlers
    this.setupKeyboard();

    // Initial render
    await this.refresh();

    // Start refresh timer
    this.startRefreshTimer();

    // Handle terminal resize
    process.stdout.on("resize", () => {
      this.renderer.updateScreenSize();
      this.render();
    });

    // Start keyboard input
    this.keyboard.start();
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    this.isRunning = false;
    this.stopRefreshTimer();
    this.keyboard.stop();
    this.renderer.clear();
    this.renderer.showCursor();
    this.renderer.render();
  }

  /**
   * Get handlers interface for external handlers module
   */
  private getHandlers(): DashboardHandlers {
    return {
      getState: () => this.state,
      setState: (updater) => {
        updater(this.state);
      },
      getSelectedPort: () => this.getSelectedPort(),
      moveSelection: (delta) => this.moveSelection(delta),
      applySorting: () => this.applySorting(),
      toggleGroup: () => this.toggleGroup(),
      refresh: () => this.refresh(),
      render: () => this.render(),
      stop: () => this.stop(),
      clearFilteredPortsCache: () => {
        this.filteredPortsCache = null;
      },
      clearDetectorCache: () => {
        this.detector.clearCache();
      },
    };
  }


  /**
   * Setup keyboard shortcuts
   */
  private setupKeyboard(): void {
    // Use extracted handlers for most shortcuts
    setupKeyboardHandlers(this.keyboard, this.getHandlers());

    // Handle search input (kept here because it needs direct access to searchBuffer)
    this.keyboard.on("*", (key: string) => {
      if (this.state.searching && key.length === 1 && /[0-9]/.test(key)) {
        this.searchBuffer += key;
        this.state.filter = this.searchBuffer;
        // Invalidate cache when filter changes
        this.filteredPortsCache = null;
        this.render();
      } else if (this.state.searching && key === "backspace") {
        this.searchBuffer = this.searchBuffer.slice(0, -1);
        this.state.filter = this.searchBuffer;
        // Invalidate cache when filter changes
        this.filteredPortsCache = null;
        this.render();
      }
    });
  }

  /**
   * Apply sorting to groups (with cache invalidation)
   */
  private applySorting(): void {
    for (const group of this.state.groups) {
      group.ports.sort((a, b) => {
        switch (this.state.sortBy) {
          case "port":
            return a.port - b.port;
          case "process":
            return a.processName.localeCompare(b.processName);
          case "pid":
            return a.pid - b.pid;
          default:
            return 0;
        }
      });
    }
    // Invalidate cache when sorting changes
    this.filteredPortsCache = null;
  }

  /**
   * Move selection up or down
   */
  private moveSelection(direction: number): void {
    const flatPorts = this.getFilteredPorts();
    if (flatPorts.length === 0) return;

    this.state.selectedIndex += direction;

    if (this.state.selectedIndex < 0) {
      this.state.selectedIndex = flatPorts.length - 1;
    } else if (this.state.selectedIndex >= flatPorts.length) {
      this.state.selectedIndex = 0;
    }
  }

  /**
   * Get filtered and flat list of ports (memoized)
   */
  private getFilteredPorts(): Array<{ port: PortInfo; group: PortGroup }> {
    // Create a simple hash of groups state (collapsed state and port count)
    const groupsHash = this.state.groups
      .map((g) => `${g.id}:${g.collapsed ? "1" : "0"}:${g.ports.length}`)
      .join("|");

    // Check cache
    if (
      this.filteredPortsCache &&
      this.filteredPortsCache.filter === this.state.filter &&
      this.filteredPortsCache.groupsHash === groupsHash &&
      this.filteredPortsCache.sortBy === this.state.sortBy
    ) {
      return this.filteredPortsCache.result;
    }

    // Recalculate
    const flat: Array<{ port: PortInfo; group: PortGroup }> = [];

    for (const group of this.state.groups) {
      if (!group.collapsed) {
        for (const port of group.ports) {
          // Apply filter
          if (this.state.filter) {
            const filterLower = this.state.filter.toLowerCase();
            const portMatch = port.port.toString().includes(this.state.filter);
            const processMatch = port.processName.toLowerCase().includes(filterLower);
            const commandMatch = port.command.toLowerCase().includes(filterLower);

            if (!portMatch && !processMatch && !commandMatch) {
              continue;
            }
          }

          flat.push({ port, group });
        }
      }
    }

    // Update cache
    this.filteredPortsCache = {
      result: flat,
      filter: this.state.filter,
      groupsHash,
      sortBy: this.state.sortBy,
    };

    return flat;
  }


  /**
   * Get currently selected port
   */
  private getSelectedPort(): { port: PortInfo; group: PortGroup } | null {
    const flatPorts = this.getFilteredPorts();
    if (flatPorts.length === 0) return null;

    const index = Math.min(this.state.selectedIndex, flatPorts.length - 1);
    return flatPorts[index] || null;
  }

  /**
   * Get port color based on type
   */
  private getPortColor(_port: PortInfo): ANSIColor {
    return Colors.brightCyan;
  }

  /**
   * Format lifetime in seconds to human-readable string
   */
  private formatLifetime(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${minutes}m${secs}s`;
    } else if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h${minutes}m`;
    } else {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      return `${days}d${hours}h`;
    }
  }

  /**
   * Handle kill action (no confirmation, like kill $(lsof -t -i:8080))
   * @deprecated Not currently used
   */
  // @ts-expect-error - Unused method, kept for potential future use
  private async _handleKill(): Promise<void> {
    const selected = this.getSelectedPort();
    if (!selected) return;

    // Show loading state
    this.state.isKilling = true;
    this.state.killingPort = selected.port.port;
    this.render();

    try {
      await killPort(selected.port, false, false);

      // Clear cache to force immediate refresh
      this.detector.clearCache();

      // Small delay to allow process to fully terminate before detection
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Always refresh immediately to show updated list
      await this.refresh();
      this.render();
    } catch (error) {
      // Clear cache and refresh even on error to show current state
      this.detector.clearCache();
      await this.refresh();
      this.render();
    } finally {
      // Clear loading state
      this.state.isKilling = false;
      this.state.killingPort = null;
      this.render();
    }
  }

  /**
   * Handle copy action
   * @deprecated Not currently used
   */
  // @ts-expect-error - Unused method, kept for potential future use
  private async _handleCopy(): Promise<void> {
    const selected = this.getSelectedPort();
    if (!selected) return;

    const command = getFullCommand(selected.port);
    await copyCommandToClipboard(command);
  }

  /**
   * Handle view command action
   * @deprecated Not currently used
   */
  // @ts-expect-error - Unused method, kept for potential future use
  private async _handleViewCommand(): Promise<void> {
    const selected = this.getSelectedPort();
    if (!selected) return;

    this.state.showCommand = true;
    // Get fresh command from platform adapter to ensure we have the full command
    try {
      const adapter = getPlatformAdapter();
      const fullCommand = await adapter.getProcessCommand(selected.port.pid);
      this.state.commandContent = fullCommand || getFullCommand(selected.port);
    } catch {
      // Fallback to stored command if fetching fails
      this.state.commandContent = getFullCommand(selected.port);
    }
    this.render();
  }

  /**
   * Handle view logs action
   * @deprecated Not currently used
   */
  // @ts-expect-error - Unused method, kept for potential future use
  private async _handleViewLogs(): Promise<void> {
    const selected = this.getSelectedPort();
    if (!selected) return;

    const logs = await viewPortLogs(selected.port);
    this.state.showLogs = true;
    this.state.logsContent = logs || "No logs available";
    this.render();
  }

  /**
   * Toggle group collapse/expand
   */
  private toggleGroup(): void {
    const selected = this.getSelectedPort();
    if (!selected) return;

    const group = this.state.groups.find((g) => g.id === selected.group.id);
    if (group) {
      group.collapsed = !group.collapsed;
    }
  }

  /**
   * Refresh port data
   */
  async refresh(): Promise<void> {
    try {
      const ports = await this.detector.detectPorts();
      const result = await this.processor.processPorts(ports);

      this.state.ports = result.ports;

      // Apply CLI filters if provided
      if (this.filterOptions.type || this.filterOptions.user || this.filterOptions.process) {
        this.state.groups = applyFiltersToGroups(
          result.groups,
          {
            type: this.filterOptions.type,
            user: this.filterOptions.user,
            process: this.filterOptions.process,
            sort: this.filterOptions.sort,
          },
          this.processor
        );
      } else {
        this.state.groups = result.groups;
      }

      this.state.lastUpdate = result.timestamp;

      // Apply sorting (use CLI sort option if provided, otherwise use state sortBy)
      const sortOption = this.filterOptions.sort || this.state.sortBy;
      if (this.filterOptions.sort) {
        // Apply CLI sort to all groups
        for (const group of this.state.groups) {
          group.ports.sort((a, b) => {
            switch (sortOption) {
              case "port":
                return a.port - b.port;
              case "process":
                return a.processName.localeCompare(b.processName);
              case "pid":
                return a.pid - b.pid;
              case "user":
                return a.user.localeCompare(b.user);
              default:
                return a.port - b.port;
            }
          });
        }
      } else {
        this.applySorting();
      }

      // Adjust selected index if needed
      const flatPorts = this.getFilteredPorts();
      if (this.state.selectedIndex >= flatPorts.length) {
        this.state.selectedIndex = Math.max(0, flatPorts.length - 1);
      }

      // Invalidate cache after refresh (groups may have changed)
      this.filteredPortsCache = null;
    } catch (error) {
      logger.error("Failed to refresh ports:", error);
    }
  }

  /**
   * Start refresh timer
   */
  private startRefreshTimer(): void {
    this.stopRefreshTimer();

    this.refreshTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.refresh();
        this.render();
      }
    }, this.state.refreshInterval);
  }

  /**
   * Stop refresh timer
   */
  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Render the dashboard (with delta rendering optimization)
   */
  render(): void {
    // For modal views, always do full render
    if (
      this.state.showHelp ||
      this.state.showConfirm ||
      this.state.showLogs ||
      this.state.showCommand ||
      this.state.showStats
    ) {
      this.renderer.clear();
      this.renderer.hideCursor();

      if (this.state.showHelp) {
        this.renderHelp();
      } else if (this.state.showConfirm) {
        this.renderConfirm();
      } else if (this.state.showLogs) {
        this.renderLogs();
      } else if (this.state.showCommand) {
        this.renderCommand();
      } else if (this.state.showStats) {
        this.renderStats();
      }

      this.renderer.render();
      this.previousRenderState = null; // Reset delta state for modal views
      return;
    }

    // For main view, use delta rendering
    const filteredPorts = this.getFilteredPorts();
    const currentState = {
      filteredPorts,
      selectedIndex: this.state.selectedIndex,
      filter: this.state.filter,
      sortBy: this.state.sortBy,
      showDetails: this.state.showDetails,
    };

    // Check and clear expired kill messages (but only if not rendering immediately)
    if (this.state.killMessage && this.state.killMessageExpiresAt) {
      if (Date.now() > this.state.killMessageExpiresAt) {
        this.state.killMessage = null;
        this.state.killMessageExpiresAt = null;
      }
    }

    // Force full render if there's a kill message (to ensure it's displayed)
    const hasKillMessage = this.state.killMessage !== null;

    // Check if we can use delta rendering
    const canUseDelta =
      !hasKillMessage &&
      this.previousRenderState !== null &&
      this.previousRenderState.filteredPorts.length === currentState.filteredPorts.length &&
      this.previousRenderState.filter === currentState.filter &&
      this.previousRenderState.sortBy === currentState.sortBy &&
      this.previousRenderState.showDetails === currentState.showDetails;

    if (canUseDelta && this.previousRenderState) {
      // Delta render: only update changed lines
      this.renderDelta(this.previousRenderState, currentState);
    } else {
      // Full render
      this.renderer.clear();
      this.renderer.hideCursor();
      this.renderMain();
      this.renderer.render();
    }

    this.previousRenderState = currentState;
  }

  /**
   * Delta render: only update changed lines
   */
  private renderDelta(
    previous: { filteredPorts: Array<{ port: PortInfo; group: PortGroup }>; selectedIndex: number },
    current: { filteredPorts: Array<{ port: PortInfo; group: PortGroup }>; selectedIndex: number }
  ): void {
    const { height } = this.renderer.getScreenSize();
    const maxHeight = height - (this.state.showDetails ? 6 : 4);

    // Find changed lines (selection change or port data change)
    const changedLines = new Set<number>();

    // Check for selection change
    if (previous.selectedIndex !== current.selectedIndex) {
      changedLines.add(previous.selectedIndex + 2); // +2 for header offset
      changedLines.add(current.selectedIndex + 2);
    }

    // Check for port data changes (simplified: check if ports at same index have different data)
    const minLength = Math.min(previous.filteredPorts.length, current.filteredPorts.length);
    for (let i = 0; i < minLength && i + 2 < maxHeight; i++) {
      const prev = previous.filteredPorts[i];
      const curr = current.filteredPorts[i];

      // Check if port data changed (simplified check)
      if (
        prev.port.pid !== curr.port.pid ||
        prev.port.port !== curr.port.port ||
        prev.port.processName !== curr.port.processName ||
        prev.port.command !== curr.port.command ||
        prev.port.lifetime !== curr.port.lifetime ||
        prev.port.type !== curr.port.type
      ) {
        changedLines.add(i + 2);
      }
    }

    // If too many changes, do full render instead
    if (changedLines.size > maxHeight / 2) {
      this.renderer.clear();
      this.renderer.hideCursor();
      this.renderMain();
      this.renderer.render();
      return;
    }

    // Render only changed lines
    this.renderer.hideCursor();

    // Render header (always check if it changed)
    this.renderer.moveTo(0, 0);
    this.renderHeader();

    // Render changed port lines
    for (const lineNum of changedLines) {
      if (lineNum >= 2 && lineNum < maxHeight) {
        const index = lineNum - 2;
        if (index < current.filteredPorts.length) {
          this.renderPortLine(current.filteredPorts[index], index, lineNum);
        }
      }
    }

    // Render footer/details if they might have changed
    if (this.state.showDetails) {
      const selected = this.getSelectedPort();
      if (selected) {
        this.renderDetails(selected, height);
      }
    }

    // Render kill message in delta renders too
    if (this.state.killMessage) {
      this.renderKillMessage();
    }

    this.renderer.render();
  }

  /**
   * Render header (extracted for delta rendering)
   */
  private renderHeader(): void {
    const filteredPorts = this.getFilteredPorts();
    const { width } = this.renderer.getScreenSize();

    this.renderer.moveTo(0, 0);
    this.renderer.styled(" wtfports ", Styles.bold, Colors.white, Backgrounds.blue);
    this.renderer.text(" ");

    if (this.state.isKilling && this.state.killingPort) {
      this.renderer.color(`Killing port ${this.state.killingPort}...`, Colors.yellow);
      this.renderer.text(" | ");
    } else if (this.state.filter) {
      this.renderer.color(`Filter: ${this.state.filter}`, Colors.yellow);
      this.renderer.text(" | ");
    }

    this.renderer.color(`Ports: ${filteredPorts.length}`, Colors.cyan);
    this.renderer.text(" | ");
    this.renderer.color(`Sort: ${this.state.sortBy}`, Colors.brightBlack);

    // Show current rank on the right side
    if (this.state.currentRank) {
      const rankText = `${this.state.currentRank}`;
      const rankX = width - rankText.length - 1;
      this.renderer.moveTo(rankX, 0);
      this.renderer.color(rankText, Colors.brightMagenta);
    }

    this.renderer.clearToEndOfLine();
  }

  /**
   * Render a single port line (extracted for delta rendering)
   */
  private renderPortLine(
    { port, group }: { port: PortInfo; group: PortGroup },
    index: number,
    y: number
  ): void {
    const { width } = this.renderer.getScreenSize();
    const isSelected = index === this.state.selectedIndex;

    const colPos = {
      selector: 0,
      port: 2,
      process: 9,
      type: 28, // Type/Category (12 chars)
      pid: 41, // PID:XXXXX (10 chars)
      protocol: 52, // TCP/UDP (6 chars)
      user: 59, // Username (10 chars)
      lifetime: 70, // Process lifetime (10 chars)
      command: 81, // Command path
    };

    // Selection indicator
    this.renderer.moveTo(colPos.selector, y);
    if (isSelected) {
      this.renderer.styled("▶", Styles.bold, Colors.yellow);
    } else {
      this.renderer.text(" ");
    }

    // PORT
    this.renderer.moveTo(colPos.port, y);
    const portColor = this.getPortColor(port);
    const portStr = pad(port.port.toString(), 5, "right");
    this.renderer.color(portStr, portColor);

    // PROCESS NAME
    this.renderer.moveTo(colPos.process, y);
    const processStr = pad(truncate(port.processName, 19), 19, "left");
    this.renderer.color(processStr, Colors.white);

    // TYPE/CATEGORY
    this.renderer.moveTo(colPos.type, y);
    const portType = port.type || group.type || "other";
    const typeStr = pad(truncate(portType, 12), 12, "left");
    const typeColor = getCategoryColor(portType);
    this.renderer.color(typeStr, typeColor);

    // PID
    this.renderer.moveTo(colPos.pid, y);
    const pidStr = pad(`PID:${port.pid}`, 10, "left");
    if (this.state.isKilling && this.state.killingPort === port.port) {
      this.renderer.styled(pidStr, Styles.bold, Colors.yellow);
    } else {
      this.renderer.color(pidStr, Colors.brightBlack);
    }

    // PROTOCOL
    this.renderer.moveTo(colPos.protocol, y);
    const protocolStr = pad(port.protocol, 6, "left");
    this.renderer.color(protocolStr, Colors.brightBlack);

    // USER
    this.renderer.moveTo(colPos.user, y);
    const userStr = pad(truncate(port.user, 10), 10, "left");
    this.renderer.color(userStr, Colors.brightBlack);

    // LIFETIME
    this.renderer.moveTo(colPos.lifetime, y);
    if (port.lifetime !== undefined) {
      const lifetimeStr = this.formatLifetime(port.lifetime);
      this.renderer.color(pad(lifetimeStr, 10, "left"), Colors.brightBlack);
    } else {
      this.renderer.color(pad("--", 10, "left"), Colors.brightBlack);
    }

    // Command/CWD (if details enabled)
    if (this.state.showDetails) {
      this.renderer.moveTo(colPos.command, y);
      const cmdWidth = width - colPos.command - 1;
      if (cmdWidth > 10) {
        const cmd = truncate(port.command, cmdWidth);
        this.renderer.styled(cmd, Styles.dim, Colors.brightBlack);
      }
    }

    this.renderer.clearToEndOfLine();
  }

  /**
   * Render details section (extracted for delta rendering)
   */
  private renderDetails(selected: { port: PortInfo; group: PortGroup }, height: number): void {
    const { width } = this.renderer.getScreenSize();
    let y = height - 4;

    this.renderer.moveTo(0, y);
    this.renderer.styled("─".repeat(width), Styles.dim, Colors.brightBlack);

    y++;
    this.renderer.moveTo(0, y);
    this.renderer.color(`Port: ${selected.port.port}`, Colors.brightCyan);
    this.renderer.text(" | ");
    this.renderer.color(`PID: ${selected.port.pid}`, Colors.brightCyan);
    this.renderer.text(" | ");
    this.renderer.color(`User: ${selected.port.user}`, Colors.brightCyan);
    this.renderer.text(" | ");
    this.renderer.color(`Protocol: ${selected.port.protocol}`, Colors.brightCyan);
    if (selected.port.lifetime !== undefined) {
      this.renderer.text(" | ");
      this.renderer.color(
        `Uptime: ${this.formatLifetime(selected.port.lifetime)}`,
        Colors.brightCyan
      );
    }
    this.renderer.clearToEndOfLine();
  }

  /**
   * Render main dashboard - Developer-friendly layout
   */
  private renderMain(): void {
    const { width, height } = this.renderer.getScreenSize();
    const filteredPorts = this.getFilteredPorts();

    // Header - Port-focused (like lsof -i :PORT)
    this.renderHeader();

    // Port list - Developer-friendly: PORT | PROCESS | PID | PROTOCOL | USER | LIFETIME | [type] COMMAND
    let y = 2;
    const maxHeight = height - (this.state.showDetails ? 6 : 4);

    for (let i = 0; i < filteredPorts.length && y < maxHeight; i++) {
      this.renderPortLine(filteredPorts[i], i, y);
      y++;
    }

    // Selected port details (like lsof output)
    const selected = this.getSelectedPort();
    if (selected && this.state.showDetails) {
      this.renderDetails(selected, height);
    }

    // Footer with shortcuts
    this.renderer.moveTo(0, height - 2);
    this.renderer.styled("─".repeat(width), Styles.dim, Colors.brightBlack);

    this.renderer.moveTo(0, height - 1);
    if (this.state.searching) {
      this.renderer.color("Search port: ", Colors.yellow);
      this.renderer.color(this.searchBuffer || "_", Colors.white);
      this.renderer.text(" ");
      this.renderer.color("(Enter to apply, ESC to cancel)", Colors.brightBlack);
    } else {
      this.renderer.color("/: search", Colors.brightBlack);
      this.renderer.text(" | ");
      this.renderer.color("k: kill", Colors.brightBlack);
      this.renderer.text(" | ");
      this.renderer.color("s: stats", Colors.brightBlack);
      this.renderer.text(" | ");
      this.renderer.color("?: help", Colors.brightBlack);
    }
    this.renderer.clearToEndOfLine();

    // Render kill message toast if present
    if (this.state.killMessage) {
      this.renderKillMessage();
    }
  }

  /**
   * Render help screen
   */
  private renderHelp(): void {
    const { height } = this.renderer.getScreenSize();

    this.renderer.moveTo(0, 0);
    this.renderer.styled(
      " Help - Keyboard Shortcuts ",
      Styles.bold,
      Colors.white,
      Backgrounds.blue
    );
    this.renderer.clearToEndOfLine();

    const helpItems = [
      ["↑/↓", "Navigate ports"],
      ["/", "Search port (like lsof -i :PORT)"],
      ["k", "Kill process (no confirmation)"],
      ["c", "Copy command to clipboard"],
      ["v", "View full command"],
      ["l", "View process logs"],
      ["s", "View statistics"],
      ["d", "Toggle details view"],
      ["1/2/3", "Sort by port/process/pid"],
      ["g", "Toggle group collapse"],
      ["?", "Toggle help"],
      ["q", "Quit"],
    ];

    let y = 2;
    for (const [key, desc] of helpItems) {
      this.renderer.moveTo(2, y);
      this.renderer.color(pad(key, 8, "right"), Colors.yellow);
      this.renderer.text("  ");
      this.renderer.text(desc);
      this.renderer.clearToEndOfLine();
      y++;
    }

    this.renderer.moveTo(0, height - 1);
    this.renderer.color("Press ? or ESC to close", Colors.brightBlack);
    this.renderer.clearToEndOfLine();
  }

  /**
   * Render confirmation dialog
   */
  private renderConfirm(): void {
    const { width, height } = this.renderer.getScreenSize();
    const centerY = Math.floor(height / 2);
    const centerX = Math.floor(width / 2);

    const message = this.state.confirmMessage;
    const messageWidth = Math.min(message.length + 4, width - 4);
    const startX = centerX - Math.floor(messageWidth / 2);

    this.renderer.moveTo(startX, centerY - 1);
    this.renderer.styled("┌" + "─".repeat(messageWidth - 2) + "┐", Styles.bold, Colors.white);

    this.renderer.moveTo(startX, centerY);
    this.renderer.styled("│", Styles.bold, Colors.white);
    this.renderer.text(" ".repeat(messageWidth - 2));
    this.renderer.styled("│", Styles.bold, Colors.white);

    this.renderer.moveTo(startX + 2, centerY);
    this.renderer.color(message, Colors.white);

    this.renderer.moveTo(startX, centerY + 1);
    this.renderer.styled("│", Styles.bold, Colors.white);
    this.renderer.text(" ".repeat(messageWidth - 2));
    this.renderer.styled("│", Styles.bold, Colors.white);

    this.renderer.moveTo(startX, centerY + 2);
    this.renderer.styled("└" + "─".repeat(messageWidth - 2) + "┘", Styles.bold, Colors.white);

    this.renderer.moveTo(startX + 2, centerY + 3);
    this.renderer.color("Press ENTER to confirm, ESC to cancel", Colors.brightBlack);
  }

  /**
   * Render logs view
   */
  private renderLogs(): void {
    const { width, height } = this.renderer.getScreenSize();

    this.renderer.moveTo(0, 0);
    this.renderer.styled(" Process Logs ", Styles.bold, Colors.white, Backgrounds.blue);
    this.renderer.clearToEndOfLine();

    if (this.state.logsContent) {
      const lines = this.state.logsContent.split("\n");
      let y = 2;
      for (const line of lines) {
        if (y >= height - 2) break;
        this.renderer.moveTo(0, y);
        this.renderer.text(truncate(line, width));
        this.renderer.clearToEndOfLine();
        y++;
      }
    }

    this.renderer.moveTo(0, height - 1);
    this.renderer.color("Press ESC to close", Colors.brightBlack);
    this.renderer.clearToEndOfLine();
  }

  /**
   * Render command view (with word wrapping for long commands)
   */
  private renderCommand(): void {
    const { width, height } = this.renderer.getScreenSize();

    this.renderer.moveTo(0, 0);
    this.renderer.styled(" Full Command ", Styles.bold, Colors.white, Backgrounds.blue);
    this.renderer.clearToEndOfLine();

    if (this.state.commandContent) {
      // Word wrap the command content
      const command = this.state.commandContent;
      const maxWidth = width;
      let y = 2;
      let currentLine = "";

      // Split by spaces to preserve word boundaries
      const words = command.split(" ");

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;

        if (testLine.length <= maxWidth) {
          currentLine = testLine;
        } else {
          // Output current line if it exists
          if (currentLine) {
            this.renderer.moveTo(0, y);
            this.renderer.color(currentLine, Colors.white);
            this.renderer.clearToEndOfLine();
            y++;

            // Check if we've run out of screen space
            if (y >= height - 2) break;
          }

          // Handle very long words that exceed line width
          if (word.length > maxWidth) {
            // Break long word into chunks
            for (let i = 0; i < word.length; i += maxWidth) {
              const chunk = word.substring(i, i + maxWidth);
              this.renderer.moveTo(0, y);
              this.renderer.color(chunk, Colors.white);
              this.renderer.clearToEndOfLine();
              y++;
              if (y >= height - 2) break;
            }
            currentLine = "";
          } else {
            currentLine = word;
          }
        }
      }

      // Output remaining line
      if (currentLine && y < height - 2) {
        this.renderer.moveTo(0, y);
        this.renderer.color(currentLine, Colors.white);
        this.renderer.clearToEndOfLine();
      }
    }

    this.renderer.moveTo(0, height - 1);
    this.renderer.color("Press ESC to close", Colors.brightBlack);
    this.renderer.clearToEndOfLine();
  }

  /**
   * Render stats modal
   */
  private renderStats(): void {
    const { width, height } = this.renderer.getScreenSize();

    this.renderer.moveTo(0, 0);
    this.renderer.styled(" Statistics ", Styles.bold, Colors.white, Backgrounds.blue);
    this.renderer.clearToEndOfLine();

    if (this.state.statsContent) {
      const lines = this.state.statsContent.split("\n");
      let y = 2;
      for (const line of lines) {
        if (y >= height - 2) break;
        this.renderer.moveTo(0, y);
        this.renderer.text(truncate(line, width));
        this.renderer.clearToEndOfLine();
        y++;
      }
    }

    this.renderer.moveTo(0, height - 1);
    this.renderer.color("Press ESC or s to close", Colors.brightBlack);
    this.renderer.clearToEndOfLine();
  }

  /**
   * Render kill message toast
   */
  private renderKillMessage(): void {
    if (!this.state.killMessage) return;

    const { width, height } = this.renderer.getScreenSize();
    const msg = this.state.killMessage;
    const emoji = msg.emoji ? `${msg.emoji} ` : "";
    const fullMessage = `${emoji}${msg.message}`;

    // Determine text color - use bright colors for better visibility
    let textColor: ANSIColor = Colors.brightGreen;
    let bgColor: string = Backgrounds.blue; // Use blue background for better contrast
    
    if (msg.color === "red") {
      textColor = Colors.brightWhite;
      bgColor = Backgrounds.red;
    } else if (msg.color === "yellow") {
      textColor = Colors.black;
      bgColor = Backgrounds.yellow;
    } else if (msg.color === "cyan") {
      textColor = Colors.brightWhite;
      bgColor = Backgrounds.cyan;
    } else {
      // Default green - use white text on green background for high contrast
      textColor = Colors.brightWhite;
      bgColor = Backgrounds.green;
    }

    // Show toast at bottom center (above footer)
    const toastY = height - 3;
    
    // Calculate available width (leave margins on both sides)
    const padding = 2; // Space on each side
    const maxMessageWidth = width - (padding * 4); // More padding for readability
    
    // Truncate message if too long
    const message = truncate(fullMessage, maxMessageWidth);
    const messageWithPadding = ` ${message} `;
    const messageWidth = messageWithPadding.length;
    
    // Center the message
    const startX = Math.max(0, Math.floor((width - messageWidth) / 2));

    // Clear the entire line first
    this.renderer.moveTo(0, toastY);
    this.renderer.clearLine();

    // Render message with background in one go - this ensures proper spacing
    this.renderer.moveTo(startX, toastY);
    this.renderer.styled(messageWithPadding, Styles.bold, textColor, bgColor);
    
    // Clear rest of line to ensure no leftover characters
    this.renderer.clearToEndOfLine();
  }
}
