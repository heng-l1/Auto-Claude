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
  // Concurrency guard for reactive worktree sync polling
  // Prevents overlapping getWorktreeStatus IPC calls when the effect fires while a check is in-flight
  const isCheckingWorktreeRef = useRef(false);

  // Worktree dialog state
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false);

  // Context menu state
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

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

  // Toast for user feedback
  const { toast } = useToast();

  const associatedTask = terminal?.associatedTaskId
    ? tasks.find((t) => t.id === terminal.associatedTaskId)
    : undefined;

  // Derive primitive variables from associatedTask for stable useEffect deps.
  // Using object properties directly (e.g., associatedTask?.specId) in deps would cause
  // the effect to re-run on every render since the task object reference may change.
  const associatedTaskSpecId = associatedTask?.specId;
  const associatedTaskTitle = associatedTask?.title;

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
          if (autoCorrectionCountRef.current > AUTO_CORRECTION_WARNING_THRESHOLD) {
            debugLog(
              `[Terminal ${id}] Auto-correction frequency warning: ${autoCorrectionCountRef.current} ` +
              `corrections in the previous ${AUTO_CORRECTION_WINDOW_MS}ms window`
            );
          }
          // Reset window
          autoCorrectionWindowStartRef.current = now;
          autoCorrectionCountRef.current = 0;
        }

        // Perform auto-correction
        debugLog(`[Terminal ${id}] Auto-correcting PTY dimensions from (${ptyDims.cols}, ${ptyDims.rows}) to (${xtermCols}, ${xtermRows})`);
        resizePtyWithTracking(xtermCols, xtermRows, 'auto-correction');
        lastAutoCorrectionTimeRef.current = now;
        autoCorrectionCountRef.current++;
      }
    }
  }, [id, resizePtyWithTracking]);

  /**
   * Setup xterm.js instance and initialize PTY connection.
   * This hook initializes the terminal UI, sets up event handlers, and creates the PTY process.
   */
  const {
    xtermRef,
    xtermInstanceRef,
    handleResize: handleXtermResize,
  } = useXterm({
    id,
    onDimensionsReady: handleDimensionsReady,
    onCheckDimensionMismatch: checkDimensionMismatch,
  });

  /**
   * Create and manage PTY process.
   * Handles subprocess spawning, IPC communication, output piping, and error handling.
   */
  const {
    isCreating,
    isConnecting,
    pendingClaudeResume,
    ptyVersion,
  } = usePtyProcess({
    id,
    cwd: effectiveCwd,
    projectPath,
    readyDimensions,
    isRecreatingRef,
    pendingWorktreeConfigRef,
    pendingTaskSwitchRef,
    isCreatedRef,
    hasAttemptedAutoResumeRef,
    isActive,
    onSetClaudeMode: setClaudeMode,
  });

  /**
   * Setup event handlers for xterm instance.
   * Pipes PTY output to terminal, handles input, and manages Claude mode transitions.
   */
  const { isInClaudeMode } = useTerminalEvents({
    id,
    xtermInstanceRef,
    remoteProcesses,
    onCommandEnter: handleCommandEnter,
    onClose,
  });

  // Auto-resume when terminal becomes active and Claude is available
  useEffect(() => {
    // Skip if:
    // - Terminal isn't active
    // - Already attempted auto-resume (prevent duplicate calls)
    // - PTY isn't ready yet
    // - Claude isn't available
    if (!isActive || hasAttemptedAutoResumeRef.current || !pendingClaudeResume) {
      return;
    }

    hasAttemptedAutoResumeRef.current = true;
    window.electronAPI.resumeTerminal(id);
  }, [isActive, pendingClaudeResume, id]);

  // Handle expansion state changes to trigger PTY resize
  useEffect(() => {
    // Only trigger resize if isExpanded actually changed (not on initial mount)
    if (prevIsExpandedRef.current === undefined) {
      prevIsExpandedRef.current = isExpanded;
      return;
    }

    if (prevIsExpandedRef.current !== isExpanded) {
      prevIsExpandedRef.current = isExpanded;
      // Trigger resize through handleXtermResize to properly measure new dimensions
      if (xtermInstanceRef.current) {
        // Schedule resize after DOM layout is updated
        setTimeout(() => {
          handleXtermResize();
        }, 0);
      }
    }
  }, [isExpanded, handleXtermResize, xtermInstanceRef]);

  // Worktree config effect - sync worktree config changes back to store
  useEffect(() => {
    if (!id) return;

    // Poll for worktree status changes and sync to store
    const interval = setInterval(async () => {
      // Prevent overlapping requests
      if (isCheckingWorktreeRef.current) return;
      isCheckingWorktreeRef.current = true;

      try {
        const status = await window.electronAPI.getWorktreeStatus(id);
        if (status.config) {
          setWorktreeConfig(id, status.config);
        }
      } catch (error) {
        debugLog(`[Terminal ${id}] Error checking worktree status: ${error}`);
      } finally {
        isCheckingWorktreeRef.current = false;
      }
    }, 5000); // Poll every 5 seconds

    return () => {
      clearInterval(interval);
    };
  }, [id, setWorktreeConfig]);

  // Cleanup effects
  useEffect(() => {
    return () => {
      isMountedRef.current = false;

      // Clean up auto-naming listener
      cleanupAutoNaming?.();

      // Clear post-creation timeout
      if (postCreationTimeoutRef.current !== null) {
        clearTimeout(postCreationTimeoutRef.current);
      }
    };
  }, [cleanupAutoNaming]);

  // Expose fit method via ref
  useImperativeHandle(ref, () => ({
    fit: () => {
      handleXtermResize();
    },
  }), [handleXtermResize]);

  // Attach resize observer to container
  useEffect(() => {
    if (!xtermRef.current) return;

    const container = xtermRef.current;
    const observer = new ResizeObserver(() => {
      // Debounce resize checks
      if (xtermInstanceRef.current) {
        handleXtermResize();
      }
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [handleXtermResize, xtermRef, xtermInstanceRef]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div
      ref={setDropRef}
      className={cn(
        'terminal-container relative flex flex-col bg-black rounded-lg overflow-hidden',
        isDragging && 'opacity-50',
        isActive && 'ring-2 ring-blue-500'
      )}
      onContextMenu={handleContextMenu}
    >
      <TerminalHeader
        id={id}
        terminal={terminal}
        isActive={isActive}
        onActivate={onActivate}
        onClose={onClose}
        onToggleExpand={onToggleExpand}
        isExpanded={isExpanded}
        isInClaudeMode={isInClaudeMode}
        isCreating={isCreating}
        isConnecting={isConnecting}
        associatedTask={associatedTask}
        tasks={tasks}
        terminalCount={terminalCount}
        dragHandleListeners={dragHandleListeners}
        onNewTaskClick={onNewTaskClick}
        onShowWorktreeDialog={() => setShowWorktreeDialog(true)}
      />

      <div ref={xtermRef} className='flex-1 overflow-hidden' />

      {showFileDropOverlay && (
        <div className='absolute inset-0 bg-blue-500 bg-opacity-20 border-2 border-dashed border-blue-500 rounded-lg pointer-events-none flex items-center justify-center'>
          <FileDown className='w-8 h-8 text-blue-500' />
        </div>
      )}

      {showWorktreeDialog && (
        <CreateWorktreeDialog
          terminalId={id}
          projectPath={projectPath}
          currentCwd={effectiveCwd}
          onClose={() => setShowWorktreeDialog(false)}
        />
      )}

      {contextMenuPos && (
        <TerminalContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          terminalId={id}
          onClose={() => setContextMenuPos(null)}
        />
      )}
    </div>
  );
});

Terminal.displayName = 'Terminal';