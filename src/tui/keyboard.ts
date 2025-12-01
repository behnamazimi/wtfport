/**
 * Keyboard input handler for TUI
 */

type KeyHandler = (
  key: string,
  sequence: string
) => void | boolean | Promise<void> | Promise<boolean>;

export class KeyboardHandler {
  private handlers: Map<string, KeyHandler> = new Map();
  private rawMode: boolean = false;
  private stdin: NodeJS.ReadStream;

  constructor() {
    this.stdin = process.stdin;
  }

  /**
   * Enable raw mode for keyboard input
   */
  enableRawMode(): void {
    if (this.rawMode) return;

    if (this.stdin.isTTY) {
      this.stdin.setRawMode(true);
      this.stdin.resume();
      this.rawMode = true;
    }
  }

  /**
   * Disable raw mode
   */
  disableRawMode(): void {
    if (!this.rawMode) return;

    if (this.stdin.isTTY) {
      this.stdin.setRawMode(false);
      this.stdin.pause();
      this.rawMode = false;
    }
  }

  /**
   * Register a key handler
   */
  on(key: string, handler: KeyHandler): void {
    this.handlers.set(key, handler);
  }

  /**
   * Remove a key handler
   */
  off(key: string): void {
    this.handlers.delete(key);
  }

  /**
   * Start listening for keyboard input
   */
  start(): void {
    this.enableRawMode();

    this.stdin.on("data", (data: Buffer) => {
      const sequence = data.toString();
      const key = this.parseKey(sequence);

      // Handle Ctrl+C
      if (key === "ctrl+c") {
        this.disableRawMode();
        process.exit(0);
        return;
      }

      // Call registered handlers
      const handler = this.handlers.get(key);
      if (handler) {
        const result = handler(key, sequence);
        // Handle async handlers
        if (result instanceof Promise) {
          result
            .then((res) => {
              if (res === false) {
                return; // Handler wants to prevent default
              }
            })
            .catch(() => {
              // Ignore errors
            });
        } else if (result === false) {
          return; // Handler wants to prevent default
        }
      }

      // Also try generic handler
      const genericHandler = this.handlers.get("*");
      if (genericHandler) {
        const result = genericHandler(key, sequence);
        if (result instanceof Promise) {
          result.catch(() => {
            // Ignore errors
          });
        }
      }
    });
  }

  /**
   * Stop listening for keyboard input
   */
  stop(): void {
    this.disableRawMode();
    this.stdin.removeAllListeners("data");
  }

  /**
   * Parse key sequence to key name
   */
  private parseKey(sequence: string): string {
    // Special keys
    if (sequence === "\x03") return "ctrl+c";
    if (sequence === "\x1b") return "escape";
    if (sequence === "\x7f" || sequence === "\b") return "backspace";
    if (sequence === "\r" || sequence === "\n") return "enter";
    if (sequence === "\t") return "tab";
    if (sequence === " ") return "space";

    // Arrow keys
    if (sequence === "\x1b[A") return "up";
    if (sequence === "\x1b[B") return "down";
    if (sequence === "\x1b[C") return "right";
    if (sequence === "\x1b[D") return "left";

    // Function keys
    if (sequence === "\x1bOP") return "f1";
    if (sequence === "\x1bOQ") return "f2";
    if (sequence === "\x1bOR") return "f3";
    if (sequence === "\x1bOS") return "f4";

    // Ctrl+key combinations
    if (sequence.length === 1) {
      const code = sequence.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        const char = String.fromCharCode(code + 96);
        return `ctrl+${char}`;
      }
    }

    // Return the character itself
    return sequence;
  }
}

/**
 * Common keyboard shortcuts mapping
 */
export const Shortcuts = {
  QUIT: "q",
  KILL: "k",
  COPY: "c",
  VIEW_COMMAND: "v",
  VIEW_LOGS: "l",
  TOGGLE_GROUP: "g",
  FILTER: "f",
  SEARCH: "/", // Port search (like lsof -i :PORT)
  HELP: "?",
  UP: "up",
  DOWN: "down",
  ENTER: "enter",
  ESCAPE: "escape",
  TOGGLE_DETAILS: "d", // Toggle showing full command/CWD
  SORT_PORT: "1", // Sort by port
  SORT_PROCESS: "2", // Sort by process name
  SORT_PID: "3", // Sort by PID
} as const;
