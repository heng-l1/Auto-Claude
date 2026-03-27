/**
 * Terminal remote process detection constants.
 *
 * Centralizes the set of process names that indicate a remote or multiplexer
 * session. Used by Terminal.tsx and TerminalHeader.tsx for badge display and
 * Claude invocation routing.
 */

/**
 * Default process names that indicate a remote or multiplexer session.
 */
export const DEFAULT_REMOTE_PROCESSES = new Set([
  'ssh',
  'mosh',
  'tmux',
  'screen',
]);

/**
 * Build the full remote process set (defaults + user-configured).
 *
 * Returns the default set directly when no custom processes are configured
 * to avoid unnecessary allocations. Custom entries are normalized via
 * trim + toLowerCase and empty strings are filtered out.
 */
export function buildRemoteProcessSet(custom?: string[]): Set<string> {
  if (!custom || custom.length === 0) return DEFAULT_REMOTE_PROCESSES;
  const merged = new Set(DEFAULT_REMOTE_PROCESSES);
  for (const p of custom) {
    const trimmed = p.trim().toLowerCase();
    if (trimmed) merged.add(trimmed);
  }
  return merged;
}
