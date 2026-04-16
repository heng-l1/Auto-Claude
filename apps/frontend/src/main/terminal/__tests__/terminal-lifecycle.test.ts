/**
 * Unit tests for restoreTerminal() lastInvokeTime behavior in terminal-lifecycle.ts.
 *
 * Under test: the grace-period timestamp initialization inside the
 *   `if (options.resumeClaudeSession && storedIsClaudeMode)` block
 *   of restoreTerminal (terminal-lifecycle.ts).
 *
 * When a terminal session is restored with resumeClaudeSession: true AND the
 * stored session had isClaudeMode: true, the restored terminal must have
 * `lastInvokeTime` set to Date.now(). Without this, the 5s grace-period guard
 * in terminal-event-handler.ts (handleTerminalData) cannot suppress the race
 * condition where shell prompt output during Claude startup would be
 * misinterpreted as a real Claude exit.
 *
 * These tests cover the three control-flow branches:
 *   1. resume enabled + stored Claude mode → lastInvokeTime IS set
 *   2. resume enabled + stored non-Claude mode → lastInvokeTime NOT set
 *   3. resume disabled (regardless of stored mode) → lastInvokeTime NOT set
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess, WindowGetter } from '../types';
import type { DataHandlerFn, RestoreOptions } from '../terminal-lifecycle';
import type { TerminalSession } from '../../terminal-session-store';

// --- Module mocks (hoisted) ---
// NOTE: vi.mock() calls are hoisted above const declarations by vitest, but the
// factory is invoked lazily when the module is imported. Mock fn references are
// prefixed with `mock` so vitest's hoisting-aware check allows the closure.

const mockSpawnPtyProcess = vi.fn();
const mockSetupPtyHandlers = vi.fn();
const mockGetActiveProfileEnv = vi.fn();

vi.mock('../pty-manager', () => ({
  spawnPtyProcess: mockSpawnPtyProcess,
  setupPtyHandlers: mockSetupPtyHandlers,
  getActiveProfileEnv: mockGetActiveProfileEnv,
  // The following are not called from restoreTerminal / createTerminal but are
  // re-exported from the module; mocked as no-ops for completeness in case
  // transitive imports surface them.
  writeToPty: vi.fn(),
  resizePty: vi.fn(),
  killPty: vi.fn(),
  setShuttingDown: vi.fn(),
  getIsShuttingDown: vi.fn(() => false),
  waitForPtyExit: vi.fn(),
}));

const mockGetSavedSessions = vi.fn();
const mockPersistSessionAsync = vi.fn();
const mockClearPendingDelete = vi.fn();

vi.mock('../session-handler', () => ({
  getSavedSessions: mockGetSavedSessions,
  persistSessionAsync: mockPersistSessionAsync,
  clearPendingDelete: mockClearPendingDelete,
  // Unused by restoreTerminal but exported by the module; mocked to prevent
  // any indirect access from throwing.
  persistAllSessionsAsync: vi.fn(),
  removePersistedSession: vi.fn(),
  releaseSessionId: vi.fn(),
  getSessionsForDate: vi.fn(() => []),
}));

vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => false),
  isLinux: vi.fn(() => true),
  isUnix: vi.fn(() => true),
  getCurrentOS: vi.fn(() => 'linux'),
}));

vi.mock('../../ipc-handlers/utils', () => ({
  safeSendToRenderer: vi.fn(),
}));

vi.mock('../../claude-code-settings', () => ({
  getClaudeCodeEnv: vi.fn(() => ({})),
}));

// fs: keep the actual module but override existsSync so cwd validation
// inside restoreTerminal / createTerminal passes without needing a real path.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

// os: keep the actual module but override homedir to a stable value.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/tmp'),
  };
});

// --- Helpers (pattern copied from claude-integration-handler.test.ts) ---
const createMockDisposable = (): pty.IDisposable => ({ dispose: vi.fn() });

const createMockPty = (): pty.IPty => ({
  pid: 123,
  cols: 80,
  rows: 24,
  process: 'bash',
  handleFlowControl: false,
  onData: vi.fn(() => createMockDisposable()),
  onExit: vi.fn(() => createMockDisposable()),
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
});

const createMockSession = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 'term-restore-1',
  title: 'Terminal 1',
  cwd: '/tmp/project',
  projectPath: '/tmp/project',
  isClaudeMode: false,
  outputBuffer: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

// Fixed "now" for deterministic lastInvokeTime assertions.
const FIXED_NOW = 1_700_000_000_000;

describe('terminal-lifecycle — restoreTerminal lastInvokeTime', () => {
  beforeEach(() => {
    // Reset all shared mock fns so call history and implementations don't leak
    // between tests. vi.clearAllMocks() in setup.ts only clears history —
    // calling mockReset() here also drops any mockReturnValue set previously.
    mockSpawnPtyProcess.mockReset();
    mockSetupPtyHandlers.mockReset();
    mockGetActiveProfileEnv.mockReset();
    mockGetSavedSessions.mockReset();
    mockPersistSessionAsync.mockReset();
    mockClearPendingDelete.mockReset();

    // Safe defaults: spawn a mock PTY, empty profile env, no saved sessions.
    mockSpawnPtyProcess.mockReturnValue({ pty: createMockPty(), shellType: 'bash' });
    mockGetActiveProfileEnv.mockReturnValue({});
    mockGetSavedSessions.mockReturnValue([]);

    // Control Date.now() so assertions on terminal.lastInvokeTime are exact.
    // Uses vi.spyOn so afterEach -> vi.restoreAllMocks() cleanly reverts.
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    // Restore spyOn spies (e.g., Date.now) to original implementations.
    // This does NOT undo vi.mock() module factories or vi.fn() mocks —
    // those are handled by the global setup.ts afterEach (vi.resetModules()).
    vi.restoreAllMocks();
  });

  it('sets lastInvokeTime to Date.now() when resumeClaudeSession: true AND stored session isClaudeMode: true', async () => {
    const session = createMockSession({ id: 'term-restore-1' });

    // Stored session must exist AND have isClaudeMode: true for the branch to execute.
    // restoreTerminal computes storedIsClaudeMode as:
    //   storedSessions.find(s => s.id === session.id)?.isClaudeMode ?? session.isClaudeMode
    mockGetSavedSessions.mockReturnValue([
      { ...session, isClaudeMode: true, claudeSessionId: 'claude-session-abc' },
    ]);

    const terminals = new Map<string, TerminalProcess>();
    const options: RestoreOptions = {
      resumeClaudeSession: true,
      captureSessionId: vi.fn(),
      onResumeNeeded: vi.fn(),
    };
    const getWindow: WindowGetter = () => null;
    const dataHandler: DataHandlerFn = vi.fn();

    const { restoreTerminal } = await import('../terminal-lifecycle');
    const result = await restoreTerminal(session, terminals, getWindow, dataHandler, options);

    expect(result.success).toBe(true);

    const terminal = terminals.get(session.id);
    expect(terminal).toBeDefined();
    // Core assertion: lastInvokeTime is set to the controlled Date.now() value.
    expect(terminal?.lastInvokeTime).toBe(FIXED_NOW);

    // Sanity checks: confirm the Claude-mode branch was actually entered
    // (otherwise the test could pass for the wrong reason, e.g., if the mock
    // chain silently bypassed the block and left all fields untouched).
    expect(terminal?.isClaudeMode).toBe(true);
    expect(terminal?.pendingClaudeResume).toBe(true);
    expect(terminal?.claudeSessionId).toBe('claude-session-abc');
  });

  it('does NOT set lastInvokeTime when stored session is NOT in Claude mode', async () => {
    const session = createMockSession({ id: 'term-restore-2' });

    // Stored session exists but isClaudeMode is false → the branch is skipped.
    mockGetSavedSessions.mockReturnValue([
      { ...session, isClaudeMode: false },
    ]);

    const terminals = new Map<string, TerminalProcess>();
    const options: RestoreOptions = {
      resumeClaudeSession: true, // resume is enabled, but stored mode is not Claude
      captureSessionId: vi.fn(),
    };

    const { restoreTerminal } = await import('../terminal-lifecycle');
    const result = await restoreTerminal(session, terminals, () => null, vi.fn(), options);

    expect(result.success).toBe(true);

    const terminal = terminals.get(session.id);
    expect(terminal).toBeDefined();
    // Branch was skipped, so lastInvokeTime remains its initialized value (undefined)
    // set by createTerminal (the TerminalProcess literal at terminal-lifecycle.ts
    // does not include lastInvokeTime, so it is undefined by default).
    expect(terminal?.lastInvokeTime).toBeUndefined();
    // The Claude-mode branch was not entered, so these fields remain defaults.
    expect(terminal?.isClaudeMode).toBe(false);
    expect(terminal?.pendingClaudeResume).toBeUndefined();
  });

  it('does NOT set lastInvokeTime when resumeClaudeSession is false', async () => {
    const session = createMockSession({ id: 'term-restore-3' });

    // Even though the stored session IS in Claude mode, resumeClaudeSession: false
    // short-circuits the AND and the branch is skipped.
    mockGetSavedSessions.mockReturnValue([
      { ...session, isClaudeMode: true, claudeSessionId: 'would-be-resumed' },
    ]);

    const terminals = new Map<string, TerminalProcess>();
    const options: RestoreOptions = {
      resumeClaudeSession: false,
      captureSessionId: vi.fn(),
    };

    const { restoreTerminal } = await import('../terminal-lifecycle');
    const result = await restoreTerminal(session, terminals, () => null, vi.fn(), options);

    expect(result.success).toBe(true);

    const terminal = terminals.get(session.id);
    expect(terminal).toBeDefined();
    // Branch skipped — all Claude-resume fields stay at their defaults.
    expect(terminal?.lastInvokeTime).toBeUndefined();
    expect(terminal?.isClaudeMode).toBe(false);
    expect(terminal?.pendingClaudeResume).toBeUndefined();
    expect(terminal?.claudeSessionId).toBeUndefined();
  });
});
