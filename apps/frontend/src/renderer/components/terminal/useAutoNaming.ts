import { useCallback, useRef } from 'react';
import { useClaudeProfileStore } from '../../stores/claude-profile-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalStore } from '../../stores/terminal-store';

/**
 * Get the default Claude terminal title based on the active profile.
 * Uses getState() for synchronous access outside React render cycle.
 * Mirrors the title logic from claude-integration-handler.ts.
 */
function getDefaultClaudeTitle(): string {
  const { profiles, activeProfileId } = useClaudeProfileStore.getState();
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  return activeProfile && !activeProfile.isDefault
    ? `Claude (${activeProfile.name})`
    : 'Claude';
}

interface UseAutoNamingOptions {
  terminalId: string;
  cwd?: string;
}

export function useAutoNaming({ terminalId, cwd }: UseAutoNamingOptions) {
  const lastCommandRef = useRef<string>('');
  const autoNameTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Incremented whenever /clear fires, so in-flight IPC calls scheduled
  // before /clear can detect the invalidation and skip applying their result.
  const generationEpochRef = useRef<number>(0);
  const autoNameTerminals = useSettingsStore((state) => state.settings.autoNameTerminals);
  const autoNameClaudeTerminals = useSettingsStore((state) => state.settings.autoNameClaudeTerminals);
  const terminal = useTerminalStore((state) => state.terminals.find((t) => t.id === terminalId));
  const updateTerminal = useTerminalStore((state) => state.updateTerminal);
  const setClaudeNamedOnce = useTerminalStore((state) => state.setClaudeNamedOnce);

  const triggerAutoNaming = useCallback(async () => {
    // Check if we have a command to base the name on
    if (!lastCommandRef.current.trim()) {
      return;
    }

    // Handle Claude mode vs regular terminal mode
    if (terminal?.isClaudeMode) {
      // In Claude mode: only rename if autoNameClaudeTerminals is enabled AND title is still default
      // This allows retries if name generation fails (title stays "Claude") and respects manual renames
      const title = terminal?.title ?? '';
      const isDefaultTitle = title === 'Claude' || /^Claude \(.*\)$/.test(title);
      if (!autoNameClaudeTerminals || !isDefaultTitle) {
        return;
      }
    } else {
      // Regular terminal mode: use the standard autoNameTerminals setting
      if (!autoNameTerminals) {
        return;
      }
    }

    const command = lastCommandRef.current.trim();

    // Skip very short commands/messages
    if (command.length < 3) {
      return;
    }

    // In Claude mode, messages are natural language prompts, not shell commands
    // Skip the shell command filtering since we want to name based on the first prompt
    if (!terminal?.isClaudeMode) {
      const commandLower = command.toLowerCase();
      const firstWord = commandLower.split(/\s+/)[0];

      // Skip common shell/navigation commands that don't represent meaningful work.
      // These commands are too generic to produce useful terminal names - they don't indicate
      // a specific task or purpose. For example, "git" could be any git operation,
      // "npm" could be install, run, or test. Meaningful names come from project-specific
      // commands like "npm run build:prod" or application-specific scripts.
      const skipCommands = [
        // Navigation & file listing
        'ls', 'cd', 'll', 'la', 'pwd', 'dir', 'tree',
        // Shell control
        'exit', 'clear', 'cls', 'reset', 'history',
        // Claude CLI - naming should come from the task description inside Claude, not the launch command
        'claude',
        // Common dev tools that are too generic
        'git', 'npm', 'yarn', 'pnpm', 'node', 'python', 'pip', 'cargo', 'go',
        'docker', 'kubectl', 'make', 'cmake',
        // Package managers
        'brew', 'apt', 'yum', 'pacman', 'choco', 'scoop', 'winget',
        // Editors
        'vim', 'nvim', 'nano', 'code', 'cursor',
        // System commands
        'cat', 'head', 'tail', 'less', 'more', 'grep', 'find', 'which', 'where',
        'echo', 'env', 'export', 'set', 'unset', 'alias', 'source',
        'chmod', 'chown', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch',
        'man', 'help', 'whoami', 'hostname', 'date', 'time', 'top', 'htop', 'ps',
      ];

      if (skipCommands.includes(firstWord)) {
        return;
      }
    }

    try {
      const epochAtStart = generationEpochRef.current;
      console.warn('[Terminal] Auto-naming triggered:', { command: command.substring(0, 80), isClaudeMode: terminal?.isClaudeMode, title: terminal?.title });
      const result = await window.electronAPI.generateTerminalName(command, terminal?.cwd || cwd);
      if (generationEpochRef.current !== epochAtStart) {
        console.warn('[Terminal] Auto-naming result discarded — /clear ran during generation');
        return;
      }
      if (result.success && result.data) {
        updateTerminal(terminalId, { title: result.data });
        // Sync to main process so title persists across hot reloads
        window.electronAPI.setTerminalTitle(terminalId, result.data);

        // Mark Claude terminal as named once to prevent repeated renames
        // Re-fetch terminal state after async operation to avoid stale closure
        const currentTerminal = useTerminalStore.getState().terminals.find((t) => t.id === terminalId);
        if (currentTerminal?.isClaudeMode) {
          setClaudeNamedOnce(terminalId, true);
        }
      } else {
        console.warn('[Terminal] Auto-naming returned failure:', result.error || 'unknown');
      }
    } catch (error) {
      console.warn('[Terminal] Auto-naming threw:', error);
    }
  }, [autoNameTerminals, autoNameClaudeTerminals, terminal?.isClaudeMode, terminal?.title, terminal?.cwd, cwd, terminalId, updateTerminal, setClaudeNamedOnce]);

  const handleCommandEnter = useCallback((command: string) => {
    const trimmed = command.trim();
    console.warn('[Terminal] handleCommandEnter:', { command: trimmed.substring(0, 80), isClaudeMode: terminal?.isClaudeMode, title: terminal?.title });
    // Reset title on /clear in Claude-mode terminals.
    // Match any prefix of /clear that's at least "/cl" — covers Tab-completed
    // commands where xterm only captured the literal keystrokes before Tab.
    // "/cl" is a unique prefix to /clear among Claude Code slash commands.
    const isClearCommand = trimmed.startsWith('/cl') && '/clear'.startsWith(trimmed);
    // /clear is a Claude-specific slash command. Don't gate this on isClaudeMode:
    // the renderer's isClaudeMode flag can lag or false-flip off (e.g., when a
    // shell-prompt pattern is detected in Claude output), leaving /clear to fall
    // through to auto-naming and produce a "clear terminal" title.
    if (isClearCommand) {
      console.warn('[Terminal] /clear detected — resetting title to default');
      if (autoNameTimeoutRef.current) {
        clearTimeout(autoNameTimeoutRef.current);
        autoNameTimeoutRef.current = null;
      }
      // Invalidate any in-flight generateTerminalName call so its result
      // can't land after this reset and overwrite the title.
      generationEpochRef.current += 1;
      const defaultTitle = getDefaultClaudeTitle();
      updateTerminal(terminalId, { title: defaultTitle });
      window.electronAPI.setTerminalTitle(terminalId, defaultTitle);
      setClaudeNamedOnce(terminalId, false);
      return;
    }

    lastCommandRef.current = command;

    if (autoNameTimeoutRef.current) {
      clearTimeout(autoNameTimeoutRef.current);
    }

    autoNameTimeoutRef.current = setTimeout(() => {
      triggerAutoNaming();
    }, 1500);
  }, [terminal?.isClaudeMode, terminalId, updateTerminal, setClaudeNamedOnce, triggerAutoNaming]);

  const cleanup = useCallback(() => {
    if (autoNameTimeoutRef.current) {
      clearTimeout(autoNameTimeoutRef.current);
      autoNameTimeoutRef.current = null;
    }
  }, []);

  return {
    handleCommandEnter,
    cleanup,
  };
}
