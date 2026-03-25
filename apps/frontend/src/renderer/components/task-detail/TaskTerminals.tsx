import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RotateCcw, FolderGit2, FolderOpen, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTerminalStore } from '../../stores/terminal-store';
import { useToast } from '../../hooks/use-toast';
import { Terminal } from '../Terminal';
import type { Task, WorktreeStatus, TerminalWorktreeConfig } from '../../../shared/types';

// ============================================
// Constants
// ============================================

/** Maximum number of terminals allowed in the task terminal tab */
const MAX_TASK_TERMINALS = 4;

// ============================================
// Types
// ============================================

interface TaskTerminalsProps {
  /** The task whose worktree should be the terminal's cwd */
  task: Task;
  /** Absolute path to the current project root */
  projectPath: string;
  /** Whether this tab is currently active/visible */
  isActive: boolean;
  /** When true, automatically invoke Claude in the first terminal after creation */
  autoLaunchClaude?: boolean;
  /** Incrementing counter that triggers a Claude invocation in the first terminal */
  claudeInvocationTrigger?: number;
}

// ============================================
// Component
// ============================================

/**
 * TaskTerminals — An embedded multi-terminal grid for the task detail modal.
 *
 * Features:
 * - Up to 4 terminals in a responsive CSS grid (1x1, 1x2, 2x2)
 * - All terminals share the same cwd (task worktree or project root)
 * - Terminals are created when the tab becomes active and destroyed on unmount
 * - Per-terminal exited overlay with recreate button
 * - Cmd/Ctrl+T keyboard shortcut to add a new terminal
 */
export function TaskTerminals({ task, projectPath, isActive, autoLaunchClaude, claudeInvocationTrigger }: TaskTerminalsProps) {
  const { t } = useTranslation(['tasks']);
  const { toast } = useToast();

  // Terminal store actions
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const setWorktreeConfig = useTerminalStore((state) => state.setWorktreeConfig);
  const setClaudeMode = useTerminalStore((state) => state.setClaudeMode);
  const allTerminals = useTerminalStore((state) => state.terminals);

  // Local state
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);

  // Refs — use refs for values needed in callbacks/effects to avoid stale closures
  const isMountedRef = useRef(true);
  const terminalIdsRef = useRef<string[]>([]);
  const initializedRef = useRef(false);
  const resolvedCwdRef = useRef<string>(projectPath);
  const worktreeConfigRef = useRef<TerminalWorktreeConfig | undefined>(undefined);
  const autoLaunchDoneRef = useRef<boolean>(false);

  // Keep refs in sync
  terminalIdsRef.current = terminalIds;

  // Track terminal statuses from the store
  const terminalStatuses = useMemo(() => {
    const map = new Map<string, string>();
    for (const id of terminalIds) {
      const term = allTerminals.find((terminal) => terminal.id === id);
      if (term) map.set(id, term.status);
    }
    return map;
  }, [allTerminals, terminalIds]);

  // Grid layout based on terminal count
  const gridLayout = useMemo(() => {
    const count = terminalIds.length;
    if (count <= 1) return { rows: 1, cols: 1 };
    if (count === 2) return { rows: 1, cols: 2 };
    return { rows: 2, cols: 2 }; // 3–4
  }, [terminalIds.length]);

  // ============================================
  // Worktree Path Resolution
  // ============================================

  const resolveWorktreePath = useCallback(async (taskId: string): Promise<string> => {
    try {
      const result = await window.electronAPI.getWorktreeStatus(taskId);
      if (!isMountedRef.current) return projectPath;

      if (result.success && result.data) {
        setWorktreeStatus(result.data);
        if (result.data.exists && result.data.worktreePath) {
          const cwd = result.data.worktreePath;
          resolvedCwdRef.current = cwd;
          worktreeConfigRef.current = {
            name: result.data.worktreePath.split('/').pop() ?? '',
            worktreePath: result.data.worktreePath,
            branchName: result.data.branch ?? '',
            baseBranch: result.data.baseBranch ?? '',
            hasGitBranch: !!result.data.branch,
            taskId: taskId,
            createdAt: new Date().toISOString(),
            terminalId: '',  // Will be set per-terminal in createTerminal
          };
          return cwd;
        }
      }
    } catch {
      // IPC call failed — fall back to project root
    }

    setWorktreeStatus({ exists: false });
    resolvedCwdRef.current = projectPath;
    worktreeConfigRef.current = undefined;
    return projectPath;
  }, [projectPath]);

  // ============================================
  // Terminal Lifecycle
  // ============================================

  const createTerminal = useCallback((cwd: string): string | null => {
    if (terminalIdsRef.current.length >= MAX_TASK_TERMINALS) {
      toast({
        title: t('tasks:kanban.terminal.maxTerminalsReached'),
        variant: 'destructive',
      });
      return null;
    }

    const newTerminal = addTerminal(cwd, projectPath);
    if (!newTerminal) {
      toast({
        title: t('tasks:kanban.terminal.maxTerminalsReached'),
        variant: 'destructive',
      });
      return null;
    }

    // Set worktree config so the Terminal header dropdown shows the correct worktree
    if (worktreeConfigRef.current) {
      setWorktreeConfig(newTerminal.id, { ...worktreeConfigRef.current, terminalId: newTerminal.id });
    }

    setTerminalIds((prev) => [...prev, newTerminal.id]);
    setActiveTerminalId(newTerminal.id);
    return newTerminal.id;
  }, [addTerminal, projectPath, setWorktreeConfig, toast, t]);

  const destroySingleTerminal = useCallback(async (id: string) => {
    try {
      await window.electronAPI.destroyTerminal(id);
    } catch {
      // Terminal may already be destroyed
    }
    removeTerminal(id);
    setTerminalIds((prev) => prev.filter((tid) => tid !== id));
    setActiveTerminalId((prev) => {
      if (prev === id) {
        const remaining = terminalIdsRef.current.filter((tid) => tid !== id);
        return remaining.length > 0 ? remaining[0] : null;
      }
      return prev;
    });
  }, [removeTerminal]);

  /** Add a new terminal at the resolved worktree cwd. Reads from ref to avoid stale closures. */
  const handleAddTerminal = useCallback(() => {
    createTerminal(resolvedCwdRef.current);
  }, [createTerminal]);

  const handleCloseTerminal = useCallback((id: string) => {
    destroySingleTerminal(id);
  }, [destroySingleTerminal]);

  const handleRecreateTerminal = useCallback(async (id: string) => {
    await destroySingleTerminal(id);
    createTerminal(resolvedCwdRef.current);
  }, [destroySingleTerminal, createTerminal]);

  // ============================================
  // Effects
  // ============================================

  // Track mount state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Reset auto-launch guard when task changes (to support re-mounting for different tasks)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset ref when task.id changes
  useEffect(() => {
    autoLaunchDoneRef.current = false;
  }, [task.id]);

  // Initialize first terminal when tab becomes active
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to isActive becoming true the first time
  useEffect(() => {
    if (!isActive || initializedRef.current) return;

    let cancelled = false;
    initializedRef.current = true;

    const setup = async () => {
      const cwd = await resolveWorktreePath(task.id);
      if (cancelled) return;
      const terminalId = createTerminal(cwd);

      // Auto-launch Claude in the first terminal if requested (one-shot)
      if (terminalId && (autoLaunchClaude || (claudeInvocationTrigger ?? 0) > 0) && !autoLaunchDoneRef.current) {
        autoLaunchDoneRef.current = true;
        setClaudeMode(terminalId, true);
        useTerminalStore.getState().updateTerminal(terminalId, {
          pendingClaudeInvocation: { contextMessage: '' }
        });
      }
    };

    setup();

    return () => {
      cancelled = true;
    };
  }, [isActive]);

  // Invoke Claude when the external trigger counter increments
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to claudeInvocationTrigger changes
  useEffect(() => {
    if ((claudeInvocationTrigger ?? 0) === 0) return; // skip initial mount

    if (terminalIdsRef.current.length > 0) {
      // Terminal already exists — invoke Claude directly on the first terminal
      const firstId = terminalIdsRef.current[0];
      setClaudeMode(firstId, true);
      window.electronAPI.invokeClaudeInTerminal(firstId, resolvedCwdRef.current);
    } else {
      // No terminals yet (tab never activated) — reset guard so the init effect
      // will handle Claude launch when the tab activates
      autoLaunchDoneRef.current = false;
    }
  }, [claudeInvocationTrigger]);

  // Keyboard shortcut: Cmd/Ctrl+T to add a new terminal
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault();
        e.stopPropagation();
        if (terminalIdsRef.current.length < MAX_TASK_TERMINALS) {
          createTerminal(resolvedCwdRef.current);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isActive, createTerminal]);

  // Cleanup all terminals on unmount
  useEffect(() => {
    return () => {
      const ids = terminalIdsRef.current;
      for (const id of ids) {
        window.electronAPI.destroyTerminal(id).catch(() => {
          // Safe to ignore during unmount
        });
        useTerminalStore.getState().removeTerminal(id);
      }
    };
  }, []);

  // ============================================
  // Derived State
  // ============================================

  const canAdd = terminalIds.length < MAX_TASK_TERMINALS;
  const hasWorktree = worktreeStatus?.exists && worktreeStatus?.worktreePath;
  const resolvedCwd = resolvedCwdRef.current;

  // ============================================
  // Render
  // ============================================

  return (
    <div className="h-full flex flex-col" data-testid="task-terminals">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border bg-muted/30 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {terminalIds.length} / {MAX_TASK_TERMINALS}
          </span>
          {/* Worktree status indicator */}
          {!worktreeStatus && (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
            </span>
          )}
          {hasWorktree && (
            <span className="flex items-center gap-1.5 truncate max-w-[400px]" title={worktreeStatus?.worktreePath ?? ''}>
              <FolderGit2 className="h-3.5 w-3.5 text-success flex-shrink-0" />
              {worktreeStatus?.worktreePath?.split('/').pop()}
            </span>
          )}
          {worktreeStatus && !hasWorktree && (
            <span className="flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5 text-warning flex-shrink-0" />
              {t('tasks:kanban.terminal.noWorktree')}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleAddTerminal}
          disabled={!canAdd}
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded text-xs',
            'text-muted-foreground hover:text-foreground hover:bg-accent',
            'transition-colors',
            !canAdd && 'opacity-50 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground'
          )}
          data-testid="task-terminal-add"
        >
          <Plus className="h-3 w-3" />
          <span>{t('tasks:kanban.terminal.addTerminal')}</span>
          <kbd className="ml-1 text-[10px] text-muted-foreground">
            {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+T
          </kbd>
        </button>
      </div>

      {/* Terminal grid */}
      <div
        className="flex-1 min-h-0 grid"
        style={{
          gridTemplateColumns: `repeat(${gridLayout.cols}, 1fr)`,
          gridTemplateRows: `repeat(${gridLayout.rows}, 1fr)`,
        }}
      >
        {terminalIds.map((id) => {
          const isExited = terminalStatuses.get(id) === 'exited';
          return (
            <div key={id} className="relative min-h-0 min-w-0 border-border [&:not(:last-child)]:border-r [&:nth-child(-n+2)]:border-b">
              <Terminal
                id={id}
                cwd={resolvedCwd}
                projectPath={projectPath}
                isActive={isActive && id === activeTerminalId}
                onClose={() => handleCloseTerminal(id)}
                onActivate={() => setActiveTerminalId(id)}
                terminalCount={terminalIds.length}
              />

              {/* Per-terminal exited overlay */}
              {isExited && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {t('tasks:kanban.terminal.terminalExited')}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRecreateTerminal(id)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm',
                        'bg-primary text-primary-foreground hover:bg-primary/90',
                        'transition-colors'
                      )}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>{t('tasks:kanban.terminal.recreate')}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
