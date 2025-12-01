/**
 * ANSI rendering utilities for terminal UI
 */

export class ANSIRenderer {
  private buffer: string[] = [];
  private screenHeight: number = 24;
  private screenWidth: number = 80;
  private estimatedBufferSize: number = 0;

  constructor() {
    this.updateScreenSize();
    // Pre-allocate buffer with estimated size (screen height * average line length)
    this.estimatedBufferSize = this.screenHeight * 100;
    this.buffer = new Array(this.estimatedBufferSize);
    this.buffer.length = 0; // Reset length but keep allocated capacity
  }

  /**
   * Update screen dimensions
   */
  updateScreenSize(): void {
    // Try to get terminal size
    try {
      const { stdout } = process;
      if (stdout.isTTY) {
        this.screenHeight = stdout.rows || 24;
        this.screenWidth = stdout.columns || 80;
        // Update estimated buffer size
        this.estimatedBufferSize = this.screenHeight * 100;
      }
    } catch {
      // Use defaults
    }
  }

  /**
   * Get screen dimensions
   */
  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  /**
   * Clear screen
   */
  clear(): void {
    // Reuse buffer array instead of creating new one
    this.buffer.length = 0;
    process.stdout.write("\x1b[2J\x1b[H");
  }

  /**
   * Save cursor position
   */
  saveCursor(): void {
    this.buffer.push("\x1b[s");
  }

  /**
   * Restore cursor position
   */
  restoreCursor(): void {
    this.buffer.push("\x1b[u");
  }

  /**
   * Move cursor to position
   */
  moveTo(x: number, y: number): void {
    this.buffer.push(`\x1b[${y + 1};${x + 1}H`);
  }

  /**
   * Hide cursor
   */
  hideCursor(): void {
    this.buffer.push("\x1b[?25l");
  }

  /**
   * Show cursor
   */
  showCursor(): void {
    this.buffer.push("\x1b[?25h");
  }

  /**
   * Clear line
   */
  clearLine(): void {
    this.buffer.push("\x1b[2K");
  }

  /**
   * Clear to end of line
   */
  clearToEndOfLine(): void {
    this.buffer.push("\x1b[K");
  }

  /**
   * Add text to buffer
   */
  text(str: string): void {
    this.buffer.push(str);
  }

  /**
   * Add colored text
   */
  color(str: string, color: ANSIColor): void {
    this.buffer.push(`${color}${str}\x1b[0m`);
  }

  /**
   * Add styled text (supports styles, colors, and backgrounds)
   */
  styled(str: string, ...styles: (ANSIStyle | ANSIColor | string)[]): void {
    const codes = styles.join("");
    this.buffer.push(`${codes}${str}\x1b[0m`);
  }

  /**
   * Render buffer to screen (optimized with array join)
   */
  render(): void {
    if (this.buffer.length > 0) {
      // Use array join which is more efficient than string concatenation
      process.stdout.write(this.buffer.join(""));
      // Reuse buffer array instead of creating new one
      this.buffer.length = 0;
    }
  }

  /**
   * Flush output
   */
  flush(): void {
    if (this.buffer.length > 0) {
      process.stdout.write(this.buffer.join(""));
      // Reuse buffer array instead of creating new one
      this.buffer.length = 0;
    }
  }
}

/**
 * ANSI color codes
 */
export const Colors = {
  reset: "\x1b[0m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
} as const;

export type ANSIColor = (typeof Colors)[keyof typeof Colors];

/**
 * ANSI style codes
 */
export const Styles = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  blink: "\x1b[5m",
  reverse: "\x1b[7m",
  hidden: "\x1b[8m",
} as const;

type ANSIStyle = (typeof Styles)[keyof typeof Styles];

/**
 * Background colors
 */
export const Backgrounds = {
  black: "\x1b[40m",
  red: "\x1b[41m",
  green: "\x1b[42m",
  yellow: "\x1b[43m",
  blue: "\x1b[44m",
  magenta: "\x1b[45m",
  cyan: "\x1b[46m",
  white: "\x1b[47m",
  brightBlack: "\x1b[100m",
  brightRed: "\x1b[101m",
  brightGreen: "\x1b[102m",
  brightYellow: "\x1b[103m",
  brightBlue: "\x1b[104m",
  brightMagenta: "\x1b[105m",
  brightCyan: "\x1b[106m",
  brightWhite: "\x1b[107m",
} as const;

/**
 * Get color for port category
 */
export function getCategoryColor(category: string): ANSIColor {
  switch (category) {
    case "dev-server":
      return Colors.green;
    case "api":
      return Colors.blue;
    case "database":
      return Colors.yellow;
    case "storybook":
      return Colors.magenta;
    case "testing":
      return Colors.cyan;
    case "unexpected":
      return Colors.red;
    default:
      return Colors.white;
  }
}

/**
 * Truncate string to fit width
 */
export function truncate(str: string, width: number, suffix: string = "..."): string {
  if (str.length <= width) return str;
  return str.slice(0, width - suffix.length) + suffix;
}

/**
 * Pad string to width
 */
export function pad(
  str: string,
  width: number,
  align: "left" | "right" | "center" = "left"
): string {
  if (str.length >= width) return str;
  const padding = width - str.length;

  switch (align) {
    case "right":
      return " ".repeat(padding) + str;
    case "center":
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return " ".repeat(left) + str + " ".repeat(right);
    default:
      return str + " ".repeat(padding);
  }
}
