import { useEffect, useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useDroppable, useDndContext } from '@dnd-kit/core';
import '@xterm/xterm/css/xterm.css';
import type { Terminal as XTerm } from '@xterm/xterm';
import { FileDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { useTerminalStore } from '../stores/terminal-store';
import { useSettingsStore } from '../stores/settings-store';
import { useToast } from '../hooks/use-toast';
import type { TerminalProps } from './terminal/types';
import type { TerminalWorktreeConfig } from '../../shared/types';
import { TerminalHeader } from './terminal/TerminalHeader';
import { TerminalContextMenu } from './terminal/TerminalContextMenu';
import { CreateWorktreeDialog } from './terminal/CreateWorktreeDialog';
import { useXterm } from './terminal/useXterm';
import { usePtyProcess } from './terminal/usePtyProcess';
import { useTerminalEvents } from './terminal/useTerminalEvents';
import { useAutoNaming } from './terminal/useAutoNaming';
import { useTerminalFileDrop } from './terminal/useTerminalFileDrop';
import { debugLog } from '../../shared/utils/debug-logger';
import { stripAnsiCodes, stripPlanModeChrome } from '../../shared/utils/ansi-sanitizer';
import { terminalBufferManager } from '../lib/terminal-buffer-manager';
import { isWindows as checkIsWindows } from '../lib/os-detection';
import { buildRemoteProcessSet } from '../../shared/constants/terminal';

/**
 * Extract plain text from an xterm.js terminal buffer.
 * Iterates buffer lines, handles wrapped lines by concatenating them,
 * strips trailing empty lines, and truncates to maxChars from the end.
 */
function extractPlainTextFromXterm(xterm: XTerm, maxChars: number): string {
  const buffer = xterm.buffer.active;
  const lines: string[] = [];

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true); // true = trim trailing whitespace
    if (line.isWrapped && lines.length > 0) {
      // Continuation of previous line - append without newline
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  // Strip trailing empty lines (unused rows below cursor)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  const fullText = lines.join('\n').trim();
  return fullText.length > maxChars ? fullText.slice(-maxChars) : fullText;
}

/** Regex to match Claude plan file paths like ~/.claude-profiles/default/plans/example.md */
const PLAN_FILE_PATH_PATTERN = /(~\/\.claude[-\w]*(?:\/[^\s/]+)*\/plans\/[^\s/]+\.md)/;

/**
 * Scan the last 30 lines of an xterm.js terminal buffer for a Claude plan file path.
 * Plan mode displays the file path in a "ctrl-g to edit in VS Code · ~/.claude..." line.
 * Returns the matched path string (e.g. ~/.claude-profiles/default/plans/foo.md) or null.
 */
function extractPlanFilePathFromXterm(xterm: XTerm): string | null {
  const buffer = xterm.buffer.active;
  const startRow = Math.max(0, buffer.length - 30);

  for (let i = buffer.length - 1; i >= startRow; i--) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    const match = text.match(PLAN_FILE_PATH_PATTERN);
    if (match) {
      return match[1];
    }
  }

  return null;
}

// Minimum dimensions to prevent PTY creation with invalid sizes
const MIN_COLS = 10;
const MIN_ROWS = 3;

// Platform detection for platform-specific timing
// Windows ConPTY is slower than Unix PTY, so we need longer grace periods
const platformIsWindows = checkIsWindows();

// Threshold in milliseconds to allow for async PTY resize acknowledgment
// Mismatches within this window after a resize are expected and not logged as warnings
// Windows needs longer grace period due to slower ConPTY resize
const DIMENSION_MISMATCH_GRACE_PERIOD_MS = platformIsWindows ? 500 : 100;

// Cooldown between auto-corrections to prevent rapid-fire corrections
// Windows needs longer cooldown due to slower ConPTY operations
const AUTO_CORRECTION_COOLDOWN_MS = platformIsWindows ? 1000 : 300;

// Auto-correction frequency monitoring
const AUTO_CORRECTION_WARNING_THRESHOLD = 5;  // Warn if > 5 corrections per minute
const AUTO_CORRECTION_WINDOW_MS = 60000;  // 1 minute window

/**
 * Handle interface exposed by Terminal component for external control.
 * Used by parent components (e.g., SortableTerminalWrapper) to trigger operations
 * like refitting the terminal after container size changes.
 */
export interface TerminalHandle {
  /** Refit the terminal to its container size */
  fit: () => void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({
  id,
  cwd,
  projectPath,
  isActive,
  onClose,
  onActivate,
  tasks = [],
  onNewTaskClick,
  terminalCount = 1,
  dragHandleListeners,
  isDragging,
  isExpanded,
  onToggleExpand,
}, ref) {
  const isMountedRef = useRef(true);
  const isCreatedRef = useRef(false);
  // Track deliberate terminal recreation (e.g., worktree switching)
  // This prevents exit handlers from triggering auto-removal during controlled recreation
  const isRecreatingRef = useRef(false);
  // Store pending worktree config during recreation to sync after PTY creation
  // This fixes a race condition where IPC calls to set worktree config happen before
  // the terminal exists in main process, causing the config to not be persisted
  const pendingWorktreeConfigRef = useRef<TerminalWorktreeConfig | null>(null);
  // Store pending task switch data (title + context message) during worktree-based PTY recreation.
  // applyWorktreeConfig sets the title to config.name (specId), but we want the human-readable title.
  // This ref bridges the title override and context message injection across the async PTY recreation gap.
  const pendingTaskSwitchRef = useRef<{ contextMessage: string; title: string } | null>(null);
  // Track last sent PTY dimensions to prevent redundant resize calls
  // This ensures terminal.resize() stays in sync with PTY dimensions
  const lastPtyDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  // Track if auto-resume has been attempted to prevent duplicate resume calls
  // This fixes the race condition where isActive and pendingClaudeResume update timing can miss the effect trigger
  const hasAttemptedAutoResumeRef = useRef(false);
  // Track when the last resize was sent to PTY for grace period logic
  // This prevents false positive mismatch warnings during async resize acknowledgment
  const lastResizeTimeRef = useRef<number>(0);
  // Track previous isExpanded state to detect actual expansion changes
  // This prevents forcing PTY resize on initial mount (only on actual state changes)
  const prevIsExpandedRef = useRef<boolean | undefined>(undefined);
  // Track when last auto-correction was performed to implement cooldown
  const lastAutoCorrectionTimeRef = useRef<number>(0);
  // Track auto-correction frequency to detect potential deeper issues
  // If corrections exceed threshold, it may indicate a persistent sync problem
  const autoCorrectionCountRef = useRef<number>(0);
  const autoCorrectionWindowStartRef = useRef<number>(Date.now());
  // Sequence number for resize operations to prevent race conditions
  // When concurrent resize calls complete out-of-order, only the latest result is applied
  const resizeSequenceRef = useRef<number>(0);
  // Track post-creation dimension check timeout for cleanup
  const postCreationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Worktree dialog state
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false);

  // Terminal store
  const terminal = useTerminalStore((state) => state.terminals.find((t) => t.id === id));
  const setClaudeMode = useTerminalStore((state) => state.setClaudeMode);
  const updateTerminal = useTerminalStore((state) => state.updateTerminal);
  const setAssociatedTask = useTerminalStore((state) => state.setAssociatedTask);
  const setWorktreeConfig = useTerminalStore((state) => state.setWorktreeConfig);

  // Use cwd from store if available (for worktree), otherwise use prop
  const effectiveCwd = terminal?.cwd || cwd;

  // Settings store for IDE preferences
  const { settings } = useSettingsStore();

  // Merge default + user-configured remote process names for badge and routing
  const remoteProcesses = useMemo(
    () => buildRemoteProcessSet(settings?.customRemoteProcesses),
    [settings?.customRemoteProcesses]
  );

  // Context menu state
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Toast for user feedback
  const { toast } = useToast();

  const associatedTask = terminal?.associatedTaskId
    ? tasks.find((t) => t.id === terminal.associatedTaskId)
    : undefined;

  // Setup drop zone for file drag-and-drop
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `terminal-${id}`,
    data: { type: 'terminal', terminalId: id }
  });

  // Check if a terminal is being dragged (vs a file)
  const { active } = useDndContext();
  const isDraggingTerminal = active?.data.current?.type === 'terminal-panel';

  // Use custom hook for native HTML5 file drop handling from FileTreeItem
  // This hook is extracted to enable proper unit testing with renderHook()
  const { isNativeDragOver, handleNativeDragOver, handleNativeDragLeave, handleNativeDrop } =
    useTerminalFileDrop({ terminalId: id });

  // Only show file drop overlay when dragging files (via @dnd-kit or native), not terminals
  const showFileDropOverlay = (isOver && !isDraggingTerminal) || isNativeDragOver;

  // Auto-naming functionality
  const { handleCommandEnter, cleanup: cleanupAutoNaming } = useAutoNaming({
    terminalId: id,
    cwd: effectiveCwd,
  });

  // Track when xterm dimensions are ready for PTY creation
  const [readyDimensions, setReadyDimensions] = useState<{ cols: number; rows: number } | null>(null);

  /**
   * Helper function to resize PTY with proper dimension tracking and race condition prevention.
   * Uses sequence numbers to ensure only the latest resize result updates the tracked dimensions.
   * This prevents stale dimension corruption when concurrent resize calls complete out-of-order.
   *
   * @param cols - Target column count
   * @param rows - Target row count
   * @param context - Context string for debug logging (e.g., "onResize", "performFit")
   */
  const resizePtyWithTracking = useCallback((cols: number, rows: number, context: string) => {
    // Increment sequence number for this resize operation
    const sequence = ++resizeSequenceRef.current;
    lastResizeTimeRef.current = Date.now();

    window.electronAPI.resizeTerminal(id, cols, rows).then((result) => {
      // Only update dimensions if this is still the latest resize operation
      // This prevents race conditions where an earlier failed call overwrites a later successful one
      if (sequence !== resizeSequenceRef.current) {
        debugLog(`[Terminal ${id}] ${context}: Ignoring stale resize result (sequence ${sequence} vs current ${resizeSequenceRef.current})`);
        return;
      }

      if (result.success) {
        lastPtyDimensionsRef.current = { cols, rows };
      } else {
        debugLog(`[Terminal ${id}] ${context} resize failed: ${result.error || 'unknown error'}`);
      }
    }).catch((error) => {
      // Only log if this is still the latest operation
      if (sequence === resizeSequenceRef.current) {
        debugLog(`[Terminal ${id}] ${context} resize error: ${error}`);
      }
    });
  }, [id]);

  // Callback when xterm has measured valid dimensions
  const handleDimensionsReady = useCallback((cols: number, rows: number) => {
    // Only set dimensions if they're valid (above minimum thresholds)
    if (cols >= MIN_COLS && rows >= MIN_ROWS) {
      debugLog(`[Terminal ${id}] handleDimensionsReady: cols=${cols}, rows=${rows} - setting readyDimensions`);
      setReadyDimensions({ cols, rows });
    } else {
      debugLog(`[Terminal ${id}] handleDimensionsReady: dimensions below minimum: cols=${cols} (min=${MIN_COLS}), rows=${rows} (min=${MIN_ROWS})`);
    }
  }, [id]);

  /**
   * Check for dimension mismatch between xterm and PTY.
   * Logs a warning if dimensions differ outside the grace period after a resize.
   * This helps diagnose text alignment issues that can occur when xterm and PTY
   * have different ideas about terminal dimensions.
   *
   * @param xtermCols - Current xterm column count
   * @param xtermRows - Current xterm row count
   * @param context - Optional context string for the log message (e.g., "after resize", "on fit")
   * @param autoCorrect - If true, automatically correct mismatches by resizing PTY
   */
  const checkDimensionMismatch = useCallback((
    xtermCols: number,
    xtermRows: number,
    context?: string,
    autoCorrect: boolean = false
  ) => {
    const ptyDims = lastPtyDimensionsRef.current;

    // Skip check if PTY hasn't been created yet (no dimensions to compare)
    if (!ptyDims) {
      return;
    }

    // Skip check if we're within the grace period after a resize
    // This prevents false positives during async PTY resize acknowledgment
    const timeSinceLastResize = Date.now() - lastResizeTimeRef.current;
    if (timeSinceLastResize < DIMENSION_MISMATCH_GRACE_PERIOD_MS) {
      return;
    }

    // Check for mismatch
    const colsMismatch = xtermCols !== ptyDims.cols;
    const rowsMismatch = xtermRows !== ptyDims.rows;

    if (colsMismatch || rowsMismatch) {
      const contextStr = context ? ` (${context})` : '';
      debugLog(
        `[Terminal ${id}] DIMENSION MISMATCH DETECTED${contextStr}: ` +
        `xterm=(cols=${xtermCols}, rows=${xtermRows}) vs PTY=(cols=${ptyDims.cols}, rows=${ptyDims.rows}) - ` +
        `delta=(cols=${xtermCols - ptyDims.cols}, rows=${xtermRows - ptyDims.rows})`
      );

      // Auto-correct if enabled, PTY is created, and cooldown has passed
      const timeSinceAutoCorrect = Date.now() - lastAutoCorrectionTimeRef.current;
      if (
        autoCorrect &&
        isCreatedRef.current &&
        timeSinceAutoCorrect >= AUTO_CORRECTION_COOLDOWN_MS &&
        xtermCols >= MIN_COLS &&
        xtermRows >= MIN_ROWS
      ) {
        // Track auto-correction frequency for monitoring
        const now = Date.now();
        if (now - autoCorrectionWindowStartRef.current >= AUTO_CORRECTION_WINDOW_MS) {
          // Log warning if previous window had excessive corrections
          if (autoCorrectionCountRef.current >= AUTO_CORRECTION_WARNING_THRESHOLD) {
            debugLog(
              `[Terminal ${id}] AUTO-CORRECTION WARNING: ${autoCorrectionCountRef.current} corrections ` +
              `in last minute - this may indicate a persistent sync issue`
            );
          }
          // Reset the window
          autoCorrectionCountRef.current = 0;
          autoCorrectionWindowStartRef.current = now;
        }
        autoCorrectionCountRef.current++;

        debugLog(`[Terminal ${id}] AUTO-CORRECTING (#${autoCorrectionCountRef.current}): resizing PTY to ${xtermCols}x${xtermRows}`);
        lastAutoCorrectionTimeRef.current = Date.now();
        resizePtyWithTracking(xtermCols, xtermRows, 'AUTO-CORRECTION');
      }
    }
  }, [id, resizePtyWithTracking]);

  // Initialize xterm with command tracking
  const {
    terminalRef,
    xtermRef,
    fit,
    write: _write,  // Output now handled by useGlobalTerminalListeners
    writeln,
    focus,
    dispose,
    handleCopy,
    handlePaste,
    selectAll,
    clearTerminal,
    cols,
    rows,
  } = useXterm({
    terminalId: id,
    onCommandEnter: handleCommandEnter,
    onResize: (cols, rows, force) => {
      // PTY dimension sync validation:
      // 1. Only resize if PTY is created
      // 2. Validate dimensions are within acceptable range
      // 3. Skip if dimensions haven't changed (prevents redundant IPC calls)
      //    Unless force=true (from refit-all after view switch), which bypasses
      //    the same-dimension guard to trigger SIGWINCH for TUI redraw
      if (!isCreatedRef.current) {
        return;
      }

      // Validate dimensions are within acceptable range
      if (cols < MIN_COLS || rows < MIN_ROWS) {
        return;
      }

      // Skip redundant resize calls if dimensions haven't changed
      // When force is true (refit-all), bypass this guard to trigger SIGWINCH
      if (!force) {
        const lastDims = lastPtyDimensionsRef.current;
        if (lastDims && lastDims.cols === cols && lastDims.rows === rows) {
          return;
        }
      }

      // Use helper to resize PTY with proper tracking and race condition prevention
      resizePtyWithTracking(cols, rows, force ? 'onResize (refit-all forced)' : 'onResize');
    },
    onDimensionsReady: handleDimensionsReady,
  });

  // Expose fit method to parent components via ref
  // This allows external triggering of terminal resize (e.g., after drag-drop reorder)
  useImperativeHandle(ref, () => ({
    fit,
  }), [fit]);

  // Use ready dimensions for PTY creation (wait until xterm has measured)
  // This prevents creating PTY with default 80x24 when container is smaller
  const ptyDimensions = useMemo(() => {
    if (readyDimensions) {
      debugLog(`[Terminal ${id}] ptyDimensions memo: using readyDimensions cols=${readyDimensions.cols}, rows=${readyDimensions.rows}`);
      return readyDimensions;
    }
    // Wait for actual measurement via onDimensionsReady callback
    // Do NOT use current cols/rows as they may be initial defaults (80x24)
    debugLog(`[Terminal ${id}] ptyDimensions memo: readyDimensions is null, returning null (skipCreation will be true)`);
    return null;
  }, [readyDimensions, id]);

  // Create PTY process - only when we have valid dimensions
  const { prepareForRecreate, resetForRecreate } = usePtyProcess({
    terminalId: id,
    cwd: effectiveCwd,
    projectPath,
    cols: ptyDimensions?.cols ?? 80,
    rows: ptyDimensions?.rows ?? 24,
    // Only allow PTY creation when dimensions are ready
    skipCreation: !ptyDimensions,
    // Pass recreation ref to coordinate with deliberate terminal destruction/recreation
    isRecreatingRef,
    onCreated: () => {
      isCreatedRef.current = true;
      // ALWAYS force PTY resize on creation/remount
      // This ensures PTY matches xterm even if PTY existed before remount (expand/minimize)
      // The root cause of text alignment issues is that when terminal remounts:
      // 1. PTY persists with old dimensions (e.g., 80x20)
      // 2. New xterm measures new container (e.g., 160x40)
      // 3. Without this force resize, PTY never gets updated
      // Read current dimensions from xterm ref to avoid stale closure values
      const currentCols = xtermRef.current?.cols;
      const currentRows = xtermRef.current?.rows;
      if (currentCols !== undefined && currentRows !== undefined && currentCols >= MIN_COLS && currentRows >= MIN_ROWS) {
        debugLog(`[Terminal ${id}] PTY created - forcing PTY resize to match xterm: cols=${currentCols}, rows=${currentRows}`);
        // Use helper to resize PTY with proper tracking and race condition prevention
        resizePtyWithTracking(currentCols, currentRows, 'PTY creation');

        // Schedule initial dimension mismatch check after PTY creation
        // This helps detect if xterm dimensions drifted during PTY setup
        // Read fresh dimensions inside the timeout to avoid stale closure
        // Store timeout ID for cleanup on unmount
        postCreationTimeoutRef.current = setTimeout(() => {
          const freshCols = xtermRef.current?.cols;
          const freshRows = xtermRef.current?.rows;
          if (freshCols !== undefined && freshRows !== undefined) {
            checkDimensionMismatch(freshCols, freshRows, 'post-PTY creation');
          }
        }, DIMENSION_MISMATCH_GRACE_PERIOD_MS + 100);
      } else {
        debugLog(`[Terminal ${id}] PTY created - no valid dimensions available for tracking (cols=${currentCols}, rows=${currentRows})`);
      }
      // If there's a pending worktree config from a recreation attempt,
      // sync it to main process now that the terminal exists.
      // This fixes the race condition where IPC calls happen before terminal creation.
      if (pendingWorktreeConfigRef.current) {
        const config = pendingWorktreeConfigRef.current;
        try {
          window.electronAPI.setTerminalWorktreeConfig(id, config);
          window.electronAPI.setTerminalTitle(id, config.name);
        } catch (error) {
          console.error('Failed to sync worktree config after PTY creation:', error);
        }
        pendingWorktreeConfigRef.current = null;
      }
      // If there's a pending task switch from a worktree-based task selection,
      // override the terminal title (which applyWorktreeConfig set to config.name/specId)
      // with the human-readable task title, and inject the context message after the shell prompt.
      if (pendingTaskSwitchRef.current) {
        const { title, contextMessage } = pendingTaskSwitchRef.current;
        pendingTaskSwitchRef.current = null;
        // Use getState() to avoid stale closures in this async callback
        useTerminalStore.getState().updateTerminal(id, { title });
        window.electronAPI.setTerminalTitle(id, title);
        // Inject context message after a delay to let the shell prompt appear.
        // Windows ConPTY is slower than Unix PTY, so it needs a longer grace period.
        setTimeout(() => {
          window.electronAPI.sendTerminalInput(id, contextMessage + '\r');
        }, platformIsWindows ? 500 : 300);
      }
      // If there's a pending Claude invocation from "Discuss in Terminal",
      // execute it now that the PTY process exists.
      // This fixes the race condition where invokeClaudeInTerminal was called
      // before the terminal existed in main process.
      const currentTerminal = useTerminalStore.getState().terminals.find(t => t.id === id);
      if (currentTerminal?.pendingClaudeInvocation) {
        const { contextMessage } = currentTerminal.pendingClaudeInvocation;
        useTerminalStore.getState().updateTerminal(id, { pendingClaudeInvocation: undefined });
        window.electronAPI.invokeClaudeInTerminal(id, effectiveCwd);
        setTimeout(() => {
          if (isMountedRef.current) {
            window.electronAPI.sendTerminalInput(id, contextMessage + '\r');
          }
        }, 3000);
      }
    },
    onError: (error) => {
      // Clear pending config on error to prevent stale config from being applied
      // if PTY is recreated later (fixes potential race condition on failed recreation)
      pendingWorktreeConfigRef.current = null;
      // Clear pending task switch to prevent ghost state from a failed worktree switch
      pendingTaskSwitchRef.current = null;
      // Clear pending Claude invocation on error to prevent stale state
      useTerminalStore.getState().updateTerminal(id, { pendingClaudeInvocation: undefined });
      writeln(`\r\n\x1b[31mError: ${error}\x1b[0m`);
    },
  });

  // Monitor for dimension mismatches between xterm and PTY
  // This effect runs when xterm dimensions change and checks for mismatches
  // after the grace period to help diagnose text alignment issues
  // Auto-correction is enabled to automatically fix any detected mismatches
  useEffect(() => {
    // Only check if PTY has been created
    if (!isCreatedRef.current) {
      return;
    }

    // Schedule a mismatch check after the grace period
    // This allows time for the PTY resize to be acknowledged
    // Enable auto-correct to automatically fix any detected mismatches
    const timeoutId = setTimeout(() => {
      checkDimensionMismatch(cols, rows, 'periodic dimension sync check', true);
    }, DIMENSION_MISMATCH_GRACE_PERIOD_MS + 100);

    return () => clearTimeout(timeoutId);
  }, [cols, rows, checkDimensionMismatch]);

  // Handle terminal events (output is now handled globally via useGlobalTerminalListeners)
  useTerminalEvents({
    terminalId: id,
    // Pass recreation ref to skip auto-removal during deliberate terminal recreation
    isRecreatingRef,
    onExit: (exitCode) => {
      isCreatedRef.current = false;
      writeln(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m`);
    },
  });

  // Focus terminal when it becomes active
  // Delay focus by 150ms to ensure performInitialFit (RAF + xterm.open() + fit) completes first.
  // Without this delay, focus() can fire before the terminal is fully fitted, causing display issues.
  // 150ms is chosen to be safely after fit completes but under the 200ms ResizeObserver debounce threshold.
  useEffect(() => {
    if (isActive) {
      const timer = setTimeout(() => {
        focus();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isActive, focus]);

  // Refit terminal when expansion state changes
  // Uses transitionend event listener and RAF-based retry logic instead of fixed timeout
  // for more reliable resizing after CSS transitions complete
  useEffect(() => {
    // Detect if this is an actual expansion state change vs initial mount
    // Only force PTY resize on actual state changes to avoid resizing with invalid dimensions on mount
    const isFirstMount = prevIsExpandedRef.current === undefined;
    const expansionStateChanged = !isFirstMount && prevIsExpandedRef.current !== isExpanded;
    debugLog(`[Terminal ${id}] Expansion effect: isExpanded=${isExpanded}, isFirstMount=${isFirstMount}, expansionStateChanged=${expansionStateChanged}, prevIsExpanded=${prevIsExpandedRef.current}`);
    prevIsExpandedRef.current = isExpanded;

    // RAF fallback for test environments where requestAnimationFrame may not be defined
    const raf = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;

    const cancelRaf = typeof cancelAnimationFrame !== 'undefined'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

    let rafId: number | null = null;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let isCleanedUp = false;
    let fitSucceeded = false;
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 50;
    const FALLBACK_TIMEOUT_MS = 300;

    // Perform fit with RAF and retry logic, following the pattern from useXterm.ts performInitialFit
    const performFit = () => {
      if (isCleanedUp) return;

      // Cancel any existing RAF to prevent multiple concurrent fit attempts
      if (rafId !== null) {
        cancelRaf(rafId);
        rafId = null;
      }

      rafId = raf(() => {
        if (isCleanedUp) return;

        // fit() returns boolean indicating success (true if container had valid dimensions)
        // biome-ignore lint/suspicious/noFocusedTests: fit() is xterm FitAddon method, not a test
        const success = fit();
        debugLog(`[Terminal ${id}] performFit: fit returned success=${success}, expansionStateChanged=${expansionStateChanged}, isCreatedRef=${isCreatedRef.current}`);

        if (success) {
          fitSucceeded = true;
          // Force repaint after expansion fit to prevent stale/garbled display.
          // Same pattern as resize handler and drag-drop refit in useXterm.ts.
          xtermRef.current?.refresh(0, (xtermRef.current?.rows ?? 1) - 1);
          // Force PTY resize only on actual expansion state changes (not initial mount)
          // This ensures PTY stays in sync even when xterm.onResize() doesn't fire
          // Read fresh dimensions from xterm ref after fit() to avoid stale closure values
          const freshCols = xtermRef.current?.cols;
          const freshRows = xtermRef.current?.rows;
          if (expansionStateChanged && isCreatedRef.current && freshCols !== undefined && freshRows !== undefined && freshCols >= MIN_COLS && freshRows >= MIN_ROWS) {
            debugLog(`[Terminal ${id}] performFit: Forcing PTY resize to cols=${freshCols}, rows=${freshRows}`);
            // Use helper to resize PTY with proper tracking and race condition prevention
            resizePtyWithTracking(freshCols, freshRows, 'performFit');
          }
        } else if (retryCount < MAX_RETRIES) {
          // Container not ready yet, retry after a short delay
          retryCount++;
          retryTimeoutId = setTimeout(performFit, RETRY_DELAY_MS);
        }
      });
    };

    // Get terminal container element for transition listening
    const container = terminalRef.current;

    // Handler for transitionend event - fits terminal after CSS transition completes
    const handleTransitionEnd = (e: TransitionEvent) => {
      // Only react to relevant transitions (height, width, flex changes)
      const relevantProps = ['height', 'width', 'flex', 'max-height', 'max-width'];
      if (relevantProps.some(prop => e.propertyName.includes(prop))) {
        // Reset retry count and success flag for new transition
        retryCount = 0;
        fitSucceeded = false;
        performFit();
      }
    };

    // Listen for transitionend on the terminal container and its parent
    // (expansion may trigger transitions on either element)
    if (container) {
      container.addEventListener('transitionend', handleTransitionEnd);
      container.parentElement?.addEventListener('transitionend', handleTransitionEnd);
    }

    // Start the fit process immediately with RAF-based retry
    // This handles cases where expansion is instant (no CSS transition)
    performFit();

    // Fallback timeout to ensure fit happens even if transitionend doesn't fire
    // This is a safety net for edge cases
    fallbackTimeoutId = setTimeout(() => {
      if (!isCleanedUp && !fitSucceeded) {
        retryCount = 0;
        performFit();
      }
    }, FALLBACK_TIMEOUT_MS);

    return () => {
      isCleanedUp = true;

      // Clean up RAF
      if (rafId !== null) {
        cancelRaf(rafId);
      }

      // Clean up retry timeout
      if (retryTimeoutId !== null) {
        clearTimeout(retryTimeoutId);
      }

      // Clean up fallback timeout
      if (fallbackTimeoutId !== null) {
        clearTimeout(fallbackTimeoutId);
      }

      // Remove event listeners
      if (container) {
        container.removeEventListener('transitionend', handleTransitionEnd);
        container.parentElement?.removeEventListener('transitionend', handleTransitionEnd);
      }
    };
  }, [isExpanded, fit, id, resizePtyWithTracking, terminalRef.current, xtermRef.current?.cols, // Force repaint after expansion fit to prevent stale/garbled display.
          // Same pattern as resize handler and drag-drop refit in useXterm.ts.
          xtermRef.current?.refresh, xtermRef.current?.rows]);

  // Trigger deferred Claude resume when terminal becomes active
  // This ensures Claude sessions are only resumed when the user actually views the terminal,
  // preventing all terminals from resuming simultaneously on app startup (which can crash the app)
  useEffect(() => {
    // Reset resume attempt tracking when terminal is no longer pending
    if (!terminal?.pendingClaudeResume) {
      hasAttemptedAutoResumeRef.current = false;
      return;
    }

    // Only attempt auto-resume once, even if the effect runs multiple times
    if (hasAttemptedAutoResumeRef.current) {
      return;
    }

    // Check if both conditions are met for auto-resume
    if (isActive && terminal?.pendingClaudeResume) {
      // Defer the resume slightly to ensure all React state updates have propagated
      // This fixes the race condition where isActive and pendingClaudeResume might update
      // at different times during the restoration flow
      const timer = setTimeout(() => {
        if (!isMountedRef.current) return;

        // Mark that we've attempted resume INSIDE the callback to prevent duplicates
        // This ensures we only mark as attempted if the timeout actually fires
        // (prevents race condition where effect re-runs before timeout executes)
        if (hasAttemptedAutoResumeRef.current) return;
        hasAttemptedAutoResumeRef.current = true;

        // Double-check conditions before resuming (state might have changed)
        const currentTerminal = useTerminalStore.getState().terminals.find((t) => t.id === id);
        if (currentTerminal?.pendingClaudeResume) {
          // Clear the pending flag and trigger the actual resume
          useTerminalStore.getState().setPendingClaudeResume(id, false);
          window.electronAPI.activateDeferredClaudeResume(id);
        }
      }, 100); // Small delay to let React finish batched updates

      return () => clearTimeout(timer);
    }
  }, [isActive, id, terminal?.pendingClaudeResume]);

  // Handle keyboard shortcuts for this terminal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if this terminal is active
      if (!isActive) return;

      // Cmd/Ctrl+W to close terminal
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }

      // Cmd/Ctrl+Shift+E to toggle expand/collapse
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        e.stopPropagation();
        onToggleExpand?.();
      }
    };

    // Use capture phase to get the event before xterm
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isActive, onClose, onToggleExpand]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      cleanupAutoNaming();

      // Clear post-creation dimension check timeout to prevent operations on unmounted component
      if (postCreationTimeoutRef.current !== null) {
        clearTimeout(postCreationTimeoutRef.current);
        postCreationTimeoutRef.current = null;
      }

      // Dispose synchronously on unmount to prevent race conditions
      // where a new terminal mounts before the old one is cleaned up.
      // The previous 100ms delay created a window where both terminals existed.
      dispose();
      isCreatedRef.current = false;
    };
  }, [dispose, cleanupAutoNaming]);

  const handleInvokeClaude = useCallback(() => {
    setClaudeMode(id, true);
    const fg = terminal?.foregroundProcess;
    if (fg && remoteProcesses.has(fg)) {
      window.electronAPI.invokeClaudeInTerminalRemote(id);
    } else {
      window.electronAPI.invokeClaudeInTerminal(id, effectiveCwd);
    }
  }, [id, effectiveCwd, setClaudeMode, terminal?.foregroundProcess, remoteProcesses]);

  const handleClick = useCallback(() => {
    onActivate();
    focus();
  }, [onActivate, focus]);

  const handleTitleChange = useCallback((newTitle: string) => {
    updateTerminal(id, { title: newTitle });
    // Sync to main process so title persists across hot reloads
    window.electronAPI.setTerminalTitle(id, newTitle);
  }, [id, updateTerminal]);

  // Wrap onNewTaskClick to include recent terminal context as initial description.
  // Uses a four-tier fallback strategy:
  //   Tier 1: Read Claude's last response from session JSONL (best quality)
  //   Tier 1.5: Read plan .md file directly from disk (cleanest plan source)
  //   Tier 2: Extract plain text from xterm buffer (correct spacing, plan chrome stripped)
  //   Tier 3: Strip ANSI from raw PTY buffer (legacy fallback, plan chrome stripped)
  const handleNewTaskClick = useCallback(async () => {
    if (!onNewTaskClick) return;
    const maxChars = 8000;

    // Tier 1: Try to extract Claude's last response from session JSONL
    const terminalState = useTerminalStore.getState().terminals.find((t) => t.id === id);
    const claudeSessionId = terminalState?.claudeSessionId;
    if (claudeSessionId && projectPath) {
      try {
        const result = await window.electronAPI.getClaudeLastResponse(projectPath, claudeSessionId);
        if (result.success && result.data) {
          onNewTaskClick(result.data, id);
          return;
        }
      } catch {
        // Tier 1 failed, fall through to tier 2
      }
    }

    // Tier 1.5: Read plan .md file directly from disk (cleanest source)
    // Plan mode displays the file path in a "ctrl-g to edit in VS Code · ~/.claude..." line.
    // If we find it, read the file directly — bypasses all session/JSONL/UI chrome issues.
    if (xtermRef.current) {
      const planFilePath = extractPlanFilePathFromXterm(xtermRef.current);
      if (planFilePath) {
        try {
          const result = await window.electronAPI.readFile(planFilePath);
          if (result.success && result.data) {
            const content = result.data.trim();
            const truncated = content.length > maxChars ? content.slice(0, maxChars) : content;
            onNewTaskClick(truncated, id);
            return;
          }
        } catch {
          // Tier 1.5 failed (file not found, permission error, etc.), fall through to tier 2
        }
      }
    }

    // Tier 2: Extract plain text from xterm buffer (preserves spacing)
    if (xtermRef.current) {
      const text = stripPlanModeChrome(stripAnsiCodes(extractPlainTextFromXterm(xtermRef.current, maxChars)));
      if (text) {
        onNewTaskClick(text, id);
        return;
      }
    }

    // Tier 3: Strip ANSI from raw PTY buffer (legacy fallback)
    const rawBuffer = terminalBufferManager.get(id);
    if (!rawBuffer) {
      onNewTaskClick(undefined, id);
      return;
    }
    const cleaned = stripPlanModeChrome(stripAnsiCodes(rawBuffer).trim());
    const recent = cleaned.length > maxChars ? cleaned.slice(-maxChars) : cleaned;
    onNewTaskClick(recent || undefined, id);
  }, [onNewTaskClick, id, projectPath, xtermRef.current]);

  // Worktree handlers
  const handleCreateWorktree = useCallback(() => {
    setShowWorktreeDialog(true);
  }, []);


  const applyWorktreeConfig = useCallback(async (config: TerminalWorktreeConfig) => {
    // IMPORTANT: Set isRecreatingRef BEFORE destruction to signal deliberate recreation
    // This prevents exit handlers from triggering auto-removal during controlled recreation
    isRecreatingRef.current = true;

    // Store pending config to be synced after PTY creation succeeds
    // This fixes race condition where IPC calls happen before terminal exists in main process
    pendingWorktreeConfigRef.current = config;

    // Set isCreatingRef BEFORE updating the store to prevent race condition
    // This prevents the PTY effect from running before destroyTerminal completes
    prepareForRecreate();

    // Update terminal store with worktree config
    setWorktreeConfig(id, config);
    // Try to sync to main process (may be ignored if terminal doesn't exist yet)
    // The onCreated callback will re-sync using pendingWorktreeConfigRef
    window.electronAPI.setTerminalWorktreeConfig(id, config);

    // Update terminal title and cwd to worktree path
    updateTerminal(id, { title: config.name, cwd: config.worktreePath });
    // Try to sync to main process (may be ignored if terminal doesn't exist yet)
    window.electronAPI.setTerminalTitle(id, config.name);

    // Destroy current PTY - a new one will be created in the worktree directory
    if (isCreatedRef.current) {
      await window.electronAPI.destroyTerminal(id);
      isCreatedRef.current = false;
    }

    // Reset PTY dimension tracking for new terminal
    // This ensures the new PTY will receive initial dimensions correctly
    lastPtyDimensionsRef.current = null;

    // Reset refs to allow recreation - effect will now trigger with new cwd
    resetForRecreate();
  }, [id, setWorktreeConfig, updateTerminal, prepareForRecreate, resetForRecreate]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: terminal?.worktreeConfig?.worktreePath is intentionally read from closure — stale value is acceptable
  const handleTaskSelect = useCallback(async (taskId: string) => {
    const selectedTask = tasks.find((t) => t.id === taskId);
    if (!selectedTask) return;

    // 1) Set immediate UI feedback (task association, title)
    setAssociatedTask(id, taskId);
    updateTerminal(id, { title: selectedTask.title });
    window.electronAPI.setTerminalTitle(id, selectedTask.title);

    // 2) Build context message
    const contextMessage = `I'm working on: ${selectedTask.title}

Description:
${selectedTask.description}

Please confirm you're ready by saying: I'm ready to work on ${selectedTask.title} - Context is loaded.`;

    // 3) Check useWorktree metadata opt-out — skip worktree lookup entirely
    if (selectedTask.metadata?.useWorktree === false) {
      window.electronAPI.sendTerminalInput(id, contextMessage + '\r');
      return;
    }

    // 4) Call getWorktreeStatus to check for existing worktree
    try {
      const result = await window.electronAPI.getWorktreeStatus(taskId);

      if (result.success && result.data?.exists && result.data.worktreePath) {
        // 5) Skip PTY recreation if terminal is already at this worktree path
        // terminal?.worktreeConfig?.worktreePath is intentionally read from closure
        // (not in deps) — stale value is acceptable, worst case = unnecessary safe recreation
        if (terminal?.worktreeConfig?.worktreePath === result.data.worktreePath) {
          window.electronAPI.sendTerminalInput(id, contextMessage + '\r');
          return;
        }

        // Build TerminalWorktreeConfig with config.name = specId (for worktree badge)
        const config: TerminalWorktreeConfig = {
          name: selectedTask.specId,
          worktreePath: result.data.worktreePath,
          branchName: result.data.branch ?? '',
          baseBranch: result.data.baseBranch ?? '',
          hasGitBranch: !!result.data.branch,
          taskId: taskId,
          createdAt: new Date().toISOString(),
          terminalId: id,
        };

        // Set pending task switch data BEFORE applyWorktreeConfig so that onCreated
        // can override the title (from specId to human-readable) and inject context
        pendingTaskSwitchRef.current = { contextMessage, title: selectedTask.title };

        await applyWorktreeConfig(config);
        return;
      }
    } catch {
      // getWorktreeStatus failed — fall through to context-only injection
    }

    // 6) Fall through: no worktree or error — just inject context message
    window.electronAPI.sendTerminalInput(id, contextMessage + '\r');
  }, [id, tasks, setAssociatedTask, updateTerminal, applyWorktreeConfig]);

  const handleClearTask = useCallback(async () => {
    setAssociatedTask(id, undefined);
    updateTerminal(id, { title: 'Claude' });
    // Sync to main process so title persists across hot reloads
    window.electronAPI.setTerminalTitle(id, 'Claude');

    // Revert task-linked worktrees to the project root.
    // Use getState() to avoid stale closure issues with worktreeConfig.
    // Only revert worktrees that have taskId set (manually created worktrees are untouched).
    const currentConfig = useTerminalStore.getState().terminals.find((t) => t.id === id)?.worktreeConfig;
    if (currentConfig?.taskId && projectPath) {
      // Follow the same PTY recreation pattern as applyWorktreeConfig
      isRecreatingRef.current = true;

      // Clear any pending refs to prevent stale state from being applied after recreation
      pendingWorktreeConfigRef.current = null;
      pendingTaskSwitchRef.current = null;

      prepareForRecreate();

      // Clear worktree config in store and main process
      setWorktreeConfig(id, undefined);
      window.electronAPI.setTerminalWorktreeConfig(id, undefined);

      // Update cwd to project root
      updateTerminal(id, { cwd: projectPath });

      // Destroy current PTY - a new one will be created at the project root
      if (isCreatedRef.current) {
        await window.electronAPI.destroyTerminal(id);
        isCreatedRef.current = false;
      }

      // Reset PTY dimension tracking for new terminal
      lastPtyDimensionsRef.current = null;

      // Reset refs to allow recreation - effect will now trigger with project root cwd
      resetForRecreate();
    }
  }, [id, projectPath, setAssociatedTask, updateTerminal, setWorktreeConfig, prepareForRecreate, resetForRecreate]);

  const handleWorktreeCreated = useCallback(async (config: TerminalWorktreeConfig) => {
    await applyWorktreeConfig(config);
  }, [applyWorktreeConfig]);

  const handleSelectWorktree = useCallback(async (config: TerminalWorktreeConfig) => {
    await applyWorktreeConfig(config);
  }, [applyWorktreeConfig]);

  const handleOpenInIDE = useCallback(async () => {
    const worktreePath = terminal?.worktreeConfig?.worktreePath;
    if (!worktreePath) return;

    const preferredIDE = settings.preferredIDE || 'vscode';
    try {
      await window.electronAPI.worktreeOpenInIDE(
        worktreePath,
        preferredIDE,
        settings.customIDEPath
      );
    } catch (err) {
      console.error('Failed to open in IDE:', err);
      toast({
        title: 'Failed to open IDE',
        description: err instanceof Error ? err.message : 'Could not launch IDE',
        variant: 'destructive',
      });
    }
  }, [terminal?.worktreeConfig?.worktreePath, settings.preferredIDE, settings.customIDEPath, toast]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  // Get backlog tasks for worktree dialog
  const backlogTasks = tasks.filter((t) => t.status === 'backlog');

  // Determine border color based on Claude busy state
  // Red (busy) = Claude is actively processing
  // Green (idle) = Claude is ready for input
  const isClaudeBusy = terminal?.isClaudeBusy;
  const showClaudeBusyIndicator = terminal?.isClaudeMode && isClaudeBusy !== undefined;

  return (
    <div
      ref={setDropRef}
      className={cn(
        'flex h-full flex-col rounded-lg border bg-[#0B0B0F] overflow-hidden transition-colors duration-150 relative',
        // Default border states
        isActive ? 'border-primary ring-1 ring-primary/20' : 'border-border',
        // File drop overlay
        showFileDropOverlay && 'ring-2 ring-info border-info',
        // Claude busy state indicator (subtle colored border when in Claude mode)
        showClaudeBusyIndicator && isClaudeBusy && 'border-red-500/60 ring-1 ring-red-500/20',
        showClaudeBusyIndicator && !isClaudeBusy && 'terminal-idle-glow'
      )}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragOver={handleNativeDragOver}
      onDragLeave={handleNativeDragLeave}
      onDrop={handleNativeDrop}
    >
      {showFileDropOverlay && (
        <div className="absolute inset-0 bg-info/10 z-10 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 bg-info/90 text-info-foreground px-3 py-2 rounded-md">
            <FileDown className="h-4 w-4" />
            <span className="text-sm font-medium">Drop to insert path</span>
          </div>
        </div>
      )}

      <TerminalHeader
        terminalId={id}
        title={terminal?.title || 'Terminal'}
        status={terminal?.status || 'idle'}
        isClaudeMode={terminal?.isClaudeMode || false}
        tasks={tasks}
        associatedTask={associatedTask}
        onClose={onClose}
        onInvokeClaude={handleInvokeClaude}
        onTitleChange={handleTitleChange}
        onTaskSelect={handleTaskSelect}
        onClearTask={handleClearTask}
        onNewTaskClick={handleNewTaskClick}
        terminalCount={terminalCount}
        worktreeConfig={terminal?.worktreeConfig}
        projectPath={projectPath}
        onCreateWorktree={handleCreateWorktree}
        onSelectWorktree={handleSelectWorktree}
        onOpenInIDE={handleOpenInIDE}
        dragHandleListeners={dragHandleListeners}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        pendingClaudeResume={terminal?.pendingClaudeResume}
        isClaudeIdle={showClaudeBusyIndicator && !isClaudeBusy}
        foregroundProcess={terminal?.foregroundProcess}
        remoteProcesses={remoteProcesses}
        hasActivityAlert={terminal?.hasActivityAlert}
      />

      <div
        ref={terminalRef}
        className="flex-1 p-1"
        style={{ minHeight: 0 }}
      />

      {/* Worktree creation dialog */}
      {projectPath && (
        <CreateWorktreeDialog
          open={showWorktreeDialog}
          onOpenChange={setShowWorktreeDialog}
          terminalId={id}
          projectPath={projectPath}
          backlogTasks={backlogTasks}
          onWorktreeCreated={handleWorktreeCreated}
        />
      )}

      {/* Context menu */}
      <TerminalContextMenu
        position={contextMenuPos}
        onClose={() => setContextMenuPos(null)}
        hasSelection={!!xtermRef.current?.hasSelection()}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onSelectAll={selectAll}
        onClear={clearTerminal}
      />
    </div>
  );
});
