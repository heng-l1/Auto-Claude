/**
 * Unit tests for handleTerminalData grace-period logic in terminal-event-handler.ts.
 *
 * Under test: the guard at terminal-event-handler.ts line 80-81
 *
 *   const recentlyInvoked = terminal.lastInvokeTime && (Date.now() - terminal.lastInvokeTime < 5000);
 *   if (!recentlyInvoked && busyState !== 'busy' && OutputParser.detectClaudeExit(data)) { ... }
 *
 * The grace period suppresses Claude exit detection for the first 5 seconds after
 * Claude is invoked, because shell output during Claude's startup can superficially
 * resemble a shell prompt returning (false-positive exit).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';
import type { EventHandlerCallbacks } from '../terminal-event-handler';

// --- Module mocks (hoisted) ---
// NOTE: vi.mock() calls are hoisted above const declarations by vitest, but the
// factory is invoked lazily when the module is imported. The `mock` prefix is the
// convention that signals "safe to reference in a hoisted factory".
const mockDetectClaudeExit = vi.fn();
const mockDetectClaudeBusyState = vi.fn();
const mockExtractClaudeSessionId = vi.fn();

vi.mock('../output-parser', () => ({
  detectClaudeExit: mockDetectClaudeExit,
  detectClaudeBusyState: mockDetectClaudeBusyState,
  extractClaudeSessionId: mockExtractClaudeSessionId,
}));

const mockHandleTokenUsage = vi.fn();

vi.mock('../claude-integration-handler', () => ({
  handleTokenUsage: mockHandleTokenUsage,
}));

vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => false),
  isLinux: vi.fn(() => false),
  isUnix: vi.fn(() => false),
  getCurrentOS: vi.fn(() => 'linux'),
}));

vi.mock('../../ipc-handlers/utils', () => ({
  safeSendToRenderer: vi.fn(),
}));

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

const createMockTerminal = (overrides: Partial<TerminalProcess> = {}): TerminalProcess => ({
  id: 'term-1',
  pty: createMockPty(),
  outputBuffer: '',
  isClaudeMode: false,
  claudeSessionId: undefined,
  claudeProfileId: undefined,
  title: 'Terminal 1',
  cwd: '/tmp/project',
  projectPath: '/tmp/project',
  ...overrides,
});

const createMockCallbacks = (): EventHandlerCallbacks => ({
  onClaudeSessionId: vi.fn(),
  onRateLimit: vi.fn(),
  onOAuthToken: vi.fn(),
  onOnboardingComplete: vi.fn(),
  onClaudeBusyChange: vi.fn(),
  onClaudeExit: vi.fn(),
});

// Fixed "now" for deterministic grace-period math
const FIXED_NOW = 10_000_000;

describe('terminal-event-handler — handleTerminalData grace period', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    // Reset mock return values to safe defaults. Individual tests override these
    // as needed to simulate exit/busy detection results.
    mockDetectClaudeExit.mockReset();
    mockDetectClaudeBusyState.mockReset();
    mockExtractClaudeSessionId.mockReset();
    mockHandleTokenUsage.mockReset();
    mockDetectClaudeExit.mockReturnValue(false);
    mockDetectClaudeBusyState.mockReturnValue(null);
    mockExtractClaudeSessionId.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses onClaudeExit when shell prompt appears within 5s grace period', async () => {
    mockDetectClaudeExit.mockReturnValue(true);
    mockDetectClaudeBusyState.mockReturnValue(null);

    const terminal = createMockTerminal({
      id: 'term-grace-1',
      isClaudeMode: true,
      lastInvokeTime: FIXED_NOW - 3000, // 3s ago — well within 5s grace
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, 'user@host:~$ ', callbacks);

    expect(callbacks.onClaudeExit).not.toHaveBeenCalled();
  });

  it('calls onClaudeExit when shell prompt appears after 5s grace period has expired', async () => {
    mockDetectClaudeExit.mockReturnValue(true);
    mockDetectClaudeBusyState.mockReturnValue(null);

    const terminal = createMockTerminal({
      id: 'term-grace-2',
      isClaudeMode: true,
      lastInvokeTime: FIXED_NOW - 6000, // 6s ago — outside 5s grace
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, 'user@host:~$ ', callbacks);

    expect(callbacks.onClaudeExit).toHaveBeenCalledTimes(1);
    expect(callbacks.onClaudeExit).toHaveBeenCalledWith(terminal);
  });

  it('calls onClaudeExit when lastInvokeTime is undefined (no grace period in effect)', async () => {
    mockDetectClaudeExit.mockReturnValue(true);
    mockDetectClaudeBusyState.mockReturnValue(null);

    const terminal = createMockTerminal({
      id: 'term-grace-3',
      isClaudeMode: true,
      lastInvokeTime: undefined,
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, 'user@host:~$ ', callbacks);

    expect(callbacks.onClaudeExit).toHaveBeenCalledTimes(1);
    expect(callbacks.onClaudeExit).toHaveBeenCalledWith(terminal);
  });

  it('suppresses onClaudeExit when busyState is "busy" even without grace period', async () => {
    // busyState === 'busy' blocks exit detection via the `busyState !== 'busy'`
    // conjunct in line 81, independent of the grace-period check.
    mockDetectClaudeExit.mockReturnValue(true);
    mockDetectClaudeBusyState.mockReturnValue('busy');

    const terminal = createMockTerminal({
      id: 'term-grace-4',
      isClaudeMode: true,
      lastInvokeTime: undefined, // no grace period — busy guard alone should suppress
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, '● Working...\nuser@host:~$ ', callbacks);

    expect(callbacks.onClaudeExit).not.toHaveBeenCalled();
  });

  it('never calls onClaudeExit when terminal.isClaudeMode is false', async () => {
    // The entire exit-detection block is wrapped in `if (terminal.isClaudeMode)`,
    // so detectClaudeExit is not even consulted for non-Claude terminals.
    mockDetectClaudeExit.mockReturnValue(true);
    mockDetectClaudeBusyState.mockReturnValue(null);

    const terminal = createMockTerminal({
      id: 'term-grace-5',
      isClaudeMode: false,
      lastInvokeTime: undefined,
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, 'user@host:~$ ', callbacks);

    expect(callbacks.onClaudeExit).not.toHaveBeenCalled();
  });

  it('calls onClaudeExit at exactly the 5000ms boundary (check is strictly < 5000)', async () => {
    // Edge case: the guard uses `< 5000`, not `<= 5000`. At exactly 5000ms old,
    // `(Date.now() - lastInvokeTime < 5000)` evaluates to `5000 < 5000` → false,
    // so recentlyInvoked is false and onClaudeExit IS called.
    mockDetectClaudeExit.mockReturnValue(true);
    mockDetectClaudeBusyState.mockReturnValue(null);

    const terminal = createMockTerminal({
      id: 'term-grace-6',
      isClaudeMode: true,
      lastInvokeTime: FIXED_NOW - 5000, // exactly 5000ms old → NOT within grace
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, 'user@host:~$ ', callbacks);

    expect(callbacks.onClaudeExit).toHaveBeenCalledTimes(1);
  });

  it('calls onClaudeExit when lastInvokeTime is 0 (falsy short-circuits the grace-period check)', async () => {
    // Edge case: the guard is `terminal.lastInvokeTime && (...)`, which short-circuits
    // to the falsy left operand when lastInvokeTime is 0. recentlyInvoked becomes 0
    // (falsy), so `!recentlyInvoked` is true and onClaudeExit IS called.
    mockDetectClaudeExit.mockReturnValue(true);
    mockDetectClaudeBusyState.mockReturnValue(null);

    const terminal = createMockTerminal({
      id: 'term-grace-7',
      isClaudeMode: true,
      lastInvokeTime: 0,
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, 'user@host:~$ ', callbacks);

    expect(callbacks.onClaudeExit).toHaveBeenCalledTimes(1);
  });

  it('suppresses even definitive exit patterns within grace period', async () => {
    // The grace-period guard at line 80-81 applies to ALL exit detection, not only
    // shell-prompt heuristics. A definitive match (e.g., "Goodbye!", "Session ended",
    // or "Resume this session with:") still causes detectClaudeExit to return true,
    // but within the grace window the callback is still suppressed. This test locks
    // that behavior in so nobody "optimizes" it away by special-casing definitive
    // patterns to bypass the guard.
    mockDetectClaudeExit.mockReturnValue(true); // simulates definitive exit match
    mockDetectClaudeBusyState.mockReturnValue(null);

    const terminal = createMockTerminal({
      id: 'term-grace-8',
      isClaudeMode: true,
      lastInvokeTime: FIXED_NOW - 2000, // 2s ago — within 5s grace period
    });
    const callbacks = createMockCallbacks();

    const { handleTerminalData } = await import('../terminal-event-handler');
    handleTerminalData(terminal, 'Goodbye!', callbacks);

    expect(callbacks.onClaudeExit).not.toHaveBeenCalled();
  });
});
