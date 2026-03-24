/**
 * ANSI escape code sanitization utility.
 *
 * Removes ANSI escape sequences from strings for clean UI display.
 * These sequences are used for terminal coloring/formatting but appear
 * as raw text in UI components.
 *
 * Example:
 * - Input:  "\x1b[90m[21:40:22.196]\x1b[0m \x1b[36m[DEBUG]\x1b[0m Sending query"
 * - Output: "[21:40:22.196] [DEBUG] Sending query"
 */

/**
 * ANSI CSI (Control Sequence Introducer) escape sequence pattern.
 * Matches the full ANSI/VT100 CSI form: ESC [ parameter-bytes intermediate-bytes final-bytes
 * - Parameter bytes: 0x30-0x3F (digits 0-9, :;<=>?) -> [0-?]* in regex
 * - Intermediate bytes: 0x20-0x2F (space and !"#$%&'()*+,-./) -> [ -/]* in regex
 * - Final bytes: 0x40-0x7E (@ through ~) -> [@-~] in regex
 *
 * Examples: \x1b[31m (red), \x1b[?25l (hide cursor), \x1b[200~ (bracketed paste start)
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * OSC (Operating System Command) escape sequences.
 * Two patterns are needed because OSC uses different terminators:
 * - BEL (bell): \x1b]...\x07 - Single character terminator
 * - ST (string terminator): \x1b]...\x1b\\ - Two character terminator (ESC + backslash)
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI OSC sequences use BEL terminator
const ANSI_OSC_BEL_PATTERN = /\x1b\][^\x07]*\x07/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI OSC sequences use ST terminator
const ANSI_OSC_ST_PATTERN = /\x1b\][^\x1b]*\x1b\\/g;

/**
 * String sequences: DCS, APC, PM, SOS.
 * These start with ESC + P/_/^/X and end with ST (ESC + backslash).
 * Examples: \x1bP...data...\x1b\\ (DCS), \x1b_...data...\x1b\\ (APC)
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI string sequences require control characters
const ANSI_STRING_SEQ_PATTERN = /\x1b[P_^X][^\x1b]*\x1b\\/g;

/**
 * Bare ESC + single character sequences (not CSI/OSC starters).
 * Catches Fe escapes and DEC private sequences:
 * \x1bM (reverse index), \x1b7/\x1b8 (save/restore cursor),
 * \x1b=/\x1b> (keypad mode), \x1bc (reset), \x1bD/\x1bE (index/newline), etc.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI bare ESC sequences require control characters
const ANSI_ESC_BARE_PATTERN = /\x1b[^[\]]/g;

/**
 * Raw C0 control characters except tab (0x09), newline (0x0a), carriage return (0x0d).
 * Also includes DEL (0x7f). These have no legitimate use in user-facing text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Stripping raw control characters is the purpose
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Removes ANSI escape codes from a string.
 *
 * @param text - The string potentially containing ANSI escape codes
 * @returns The string with all ANSI escape sequences removed
 *
 * @example
 * ```ts
 * stripAnsiCodes('\x1b[90m[21:40:22.196]\x1b[0m \x1b[36m[DEBUG]\x1b[0m')
 * // Returns: '[21:40:22.196] [DEBUG]'
 * ```
 */
export function stripAnsiCodes(text: string): string {
  if (!text) return '';

  return text
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_OSC_BEL_PATTERN, '')
    .replace(ANSI_OSC_ST_PATTERN, '')
    .replace(ANSI_STRING_SEQ_PATTERN, '')
    .replace(ANSI_ESC_BARE_PATTERN, '')
    .replace(/\x1b/g, '') // lone ESC at string boundaries
    .replace(CONTROL_CHARS_PATTERN, '');
}

// ---------------------------------------------------------------------------
// Plan mode chrome stripping
// ---------------------------------------------------------------------------

/**
 * Plan mode border line pattern.
 * Matches lines consisting of 10 or more ╌ (box drawings light double dash horizontal)
 * characters, optionally surrounded by whitespace. These borders frame the plan content
 * in Claude's plan mode terminal UI.
 */
const PLAN_BORDER_PATTERN = /^\s*╌{10,}\s*$/;

/**
 * Known plan mode UI chrome patterns to strip when border-based extraction
 * is not possible. Each pattern matches a full line of terminal UI chrome.
 */
const PLAN_CHROME_PATTERNS: RegExp[] = [
  /^\s*⏺\s*Updated plan\s*$/,
  /^\s*⎿\s*\/plan to preview\s*$/,
  /^\s*─{3,}\s*$/,
  /^\s*Ready to code\?\s*$/,
  /^\s*Here is Claude's plan:\s*$/,
  /^\s*Claude has written up a plan/,
  /^\s*❯\s*\d+\./,
  /^\s*\d+\.\s*(Yes|Type here)/,
  /^\s*ctrl-g to edit/,
];

/**
 * Markers that indicate plan mode output is present in the text.
 * Used as a pre-check to avoid modifying non-plan terminal output.
 */
const PLAN_MARKER_PATTERNS: RegExp[] = [
  PLAN_BORDER_PATTERN,
  /⏺\s*Updated plan/,
  /Ready to code\?/,
  /ctrl-g to edit/,
];

/**
 * Strips Claude plan mode terminal UI chrome from text.
 *
 * Uses a two-phase approach:
 * - **Phase 1 (border extraction):** If `╌` border lines (10+ chars) are found,
 *   extracts only the content between the first and last borders. If only one border
 *   is found (truncated output), takes content above it.
 * - **Phase 2 (pattern stripping):** If Phase 1 yields no result, strips known UI
 *   patterns line by line (headers, menu items, prompts, horizontal rules).
 *
 * Returns the input unchanged if no plan mode markers are detected,
 * making it safe to apply to any terminal output.
 *
 * @param text - The string potentially containing plan mode UI chrome
 * @returns The string with plan mode chrome removed, or the original string if
 *          no plan mode markers were detected
 *
 * @example
 * ```ts
 * const planOutput = [
 *   '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
 *   '# My Plan',
 *   '- Step 1',
 *   '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
 *   'Ready to code?',
 * ].join('\n');
 * stripPlanModeChrome(planOutput)
 * // Returns: '# My Plan\n- Step 1'
 * ```
 */
export function stripPlanModeChrome(text: string): string {
  if (!text) return '';

  // Pre-check: only process text that contains plan mode markers
  const hasMarkers = PLAN_MARKER_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasMarkers) return text;

  const lines = text.split('\n');

  // Phase 1: Border-based extraction
  const borderIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (PLAN_BORDER_PATTERN.test(lines[i])) {
      borderIndices.push(i);
    }
  }

  if (borderIndices.length >= 2) {
    // Extract content between first and last borders
    const firstBorder = borderIndices[0];
    const lastBorder = borderIndices[borderIndices.length - 1];
    const extracted = lines.slice(firstBorder + 1, lastBorder).join('\n').trim();
    if (extracted) return extracted;
  }

  if (borderIndices.length === 1) {
    // Truncated output: take content above the single border
    const border = borderIndices[0];
    const extracted = lines.slice(0, border).join('\n').trim();
    if (extracted) return extracted;
  }

  // Phase 2: Line-by-line pattern stripping
  const filtered = lines.filter(
    (line) => !PLAN_CHROME_PATTERNS.some((pattern) => pattern.test(line)),
  );

  return filtered.join('\n').trim();
}
