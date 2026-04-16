/**
 * Worktree Handlers — Merge Timeout Tests (B1)
 *
 * Covers the B1 timeout contract added in spec 119:
 *  - When the backend merge subprocess never emits 'exit'/'close', the IPC
 *    handler must resolve with `{ success: true, data: { success: false,
 *    status: 'unknown', timeout: true, ... } }` after MERGE_TIMEOUT_MS
 *    (600_000 ms) so the renderer can route the task to 'human_review'
 *    instead of leaving the UI spinning or marking the task as done.
 *  - On normal completion (code === 0), the handler must resolve with
 *    `data.status: 'ok'` and `data.success: true`.
 *
 * Pattern: combines the spawn-mock + fake-timers approach from
 * apps/frontend/src/main/platform/__tests__/process-kill.test.ts with
 * the IPC-handler capture pattern used in
 * apps/frontend/src/main/ipc-handlers/task/__tests__/logs-integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'events';

// -----------------------------------------------------------------------------
// Mocks — declared before any dynamic import of the module under test.
// -----------------------------------------------------------------------------

// child_process.spawn — returns a fresh EventEmitter for each test. Tests pull
// the most recent spawn handle via `mockSpawn.mock.results[...]`.
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
    execFileSync: mockExecFileSync,
  };
});

// fs — keep real helpers for setup.ts but stub what the merge handler touches.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
    statSync: actual.statSync,
    readFileSync: vi.fn(() => '{}'),
    promises: {
      ...actual.promises,
      // Every plan-read raises ENOENT — the handler's retry/outer-catch
      // treats ENOENT as non-fatal, so plan updates short-circuit cleanly.
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// electron — a local mockIpcHandle that captures (channel, handler) pairs so
// tests can call them directly.
const ipcHandlers: Record<string, (event: unknown, ...args: unknown[]) => Promise<unknown>> = {};
const mockIpcHandle = vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
  ipcHandlers[channel] = handler;
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcHandle,
    on: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getAppPath: vi.fn(() => '/tmp/test-app'),
    getVersion: vi.fn(() => '0.1.0'),
    isPackaged: false,
  },
}));

// project-store — findTaskAndProject relies on projectStore.getProjects/getTasks.
vi.mock('../../../project-store', () => ({
  projectStore: {
    getProjects: vi.fn(() => [
      {
        id: 'project-1',
        name: 'Test Project',
        path: '/tmp/test-project',
        autoBuildPath: '.auto-claude',
        settings: { branchPrefix: 'auto-claude' },
      },
    ]),
    getTasks: vi.fn(() => [
      {
        id: 'task-1',
        specId: '119-test-spec',
        title: 'Test Task',
        status: 'in_progress',
      },
    ]),
    getProject: vi.fn(),
  },
}));

// python-env-manager — env is always "ready" so the handler skips initialize().
vi.mock('../../../python-env-manager', () => ({
  getConfiguredPythonPath: vi.fn(() => '/usr/bin/python3'),
  PythonEnvManager: class {},
  pythonEnvManager: {
    isEnvReady: vi.fn(() => true),
    getPythonEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  },
}));

vi.mock('../../../updater/path-resolver', () => ({
  getEffectiveSourcePath: vi.fn(() => '/tmp/test-source'),
}));

vi.mock('../../../rate-limit-detector', () => ({
  getBestAvailableProfileEnv: vi.fn(() => ({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' },
    wasSwapped: false,
    profileName: 'default',
  })),
}));

vi.mock('../../../python-detector', () => ({
  parsePythonCommand: vi.fn((cmd: string) => [cmd, []]),
}));

vi.mock('../../../cli-tool-manager', () => ({
  getToolPath: vi.fn((name: string) => `/usr/bin/${name}`),
}));

vi.mock('../../../worktree-paths', () => ({
  getTaskWorktreeDir: vi.fn(() => '/tmp/test-project/.auto-claude/worktrees/tasks/119-test-spec'),
  findTaskWorktree: vi.fn(() => '/tmp/test-project/.auto-claude/worktrees/tasks/119-test-spec'),
}));

vi.mock('../plan-file-utils', () => ({
  persistPlanStatus: vi.fn(),
  updateTaskMetadataPrUrl: vi.fn(),
}));

vi.mock('../../../utils/git-isolation', () => ({
  getIsolatedGitEnv: vi.fn(() => ({})),
  refreshGitIndex: vi.fn(),
}));

vi.mock('../../../utils/worktree-cleanup', () => ({
  cleanupWorktree: vi.fn().mockResolvedValue({
    success: true,
    warnings: [],
    branch: 'auto-claude/119-test-spec',
  }),
}));

vi.mock('../../../utils/roadmap-utils', () => ({
  updateRoadmapFeatureOutcome: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  killProcessGracefully: vi.fn(),
  isWindows: vi.fn(() => false),
}));

vi.mock('../../../../shared/utils/ansi-sanitizer', () => ({
  stripAnsiCodes: vi.fn((s: string) => s),
}));

vi.mock('../../../task-state-manager', () => ({
  taskStateManager: {
    handleManualStatusChange: vi.fn(),
  },
}));

// -----------------------------------------------------------------------------
// Helpers — build fake ChildProcess instances that satisfy the handler.
// -----------------------------------------------------------------------------

function createFakeChildProcess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: Mock;
  killed: boolean;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: Mock;
    killed: boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 12345;
  proc.kill = vi.fn();
  proc.killed = false;
  return proc;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('TASK_WORKTREE_MERGE handler — B1 timeout contract', () => {
  // MERGE_TIMEOUT_MS is local to the handler; mirrored here so test assertions
  // don't have to reach into module internals.
  const MERGE_TIMEOUT_MS = 600_000;

  let fakeProcess: ReturnType<typeof createFakeChildProcess>;
  let getMainWindow: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Reset the captured handler registry so each test gets a fresh handle.
    for (const key of Object.keys(ipcHandlers)) delete ipcHandlers[key];

    // Fresh spawn-able process for each test.
    fakeProcess = createFakeChildProcess();
    mockSpawn.mockReturnValue(fakeProcess);

    // Stage-only pre-check (spawnSync for `git diff --staged --name-only`)
    // returns status !== 0 so the handler falls through to the spawn path
    // instead of short-circuiting on "already staged".
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });

    // Any execFileSync path (git status, rev-parse, etc.) can fail silently —
    // the handler wraps these in try/catch for debug logging only.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('execFileSync stubbed');
    });

    // Fake BrowserWindow so timeout/error events can be forwarded.
    getMainWindow = vi.fn(() => ({
      webContents: { send: vi.fn() },
    } as unknown as Electron.BrowserWindow));

    // Import + register handlers AFTER the mocks are in place so the module
    // picks up the mocked dependencies.
    const { registerWorktreeHandlers } = await import('../worktree-handlers');
    const { pythonEnvManager } = await import('../../../python-env-manager');
    registerWorktreeHandlers(pythonEnvManager as never, getMainWindow);
  });

  afterEach(() => {
    // Per process-kill.test.ts pattern: real timers + clear all mocks.
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves with { success: false, status: "unknown", timeout: true } after MERGE_TIMEOUT_MS when child never exits', async () => {
    const handler = ipcHandlers['task:worktreeMerge'];
    expect(handler).toBeDefined();

    // Invoke the handler with `noCommit: true` so the spawn path is reached
    // without routing through worktree cleanup.
    const resultPromise = handler({}, 'task-1', { noCommit: true });

    // Let the async preamble (env ready check, pre-check spawnSync, etc.) run
    // so the handler reaches the spawn() + setTimeout() setup.
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Sanity check: the child never emits 'exit'/'close'/'error'. The only
    // way the promise resolves is via the timeout branch.
    expect(fakeProcess.listenerCount('close')).toBeGreaterThan(0);
    expect(fakeProcess.listenerCount('exit')).toBeGreaterThan(0);

    // Fire the timeout.
    await vi.advanceTimersByTimeAsync(MERGE_TIMEOUT_MS);

    const result = (await resultPromise) as {
      success: boolean;
      data: { success: boolean; status: string; timeout?: boolean; error?: string; message?: string };
    };

    // Per spec B1 contract: outer IPC result is success:true so the renderer
    // can read `data.*`. The inner `data.success` must be false and
    // `data.status` must be 'unknown' so the task is never routed to 'done'.
    expect(result.success).toBe(true);
    expect(result.data.success).toBe(false);
    expect(result.data.status).toBe('unknown');
    expect(result.data.timeout).toBe(true);
    expect(result.data.error).toBe('Merge timed out');
    expect(typeof result.data.message).toBe('string');
    expect(result.data.message).toMatch(/Merge state unknown/);
  });

  it('does not fire timeout before MERGE_TIMEOUT_MS elapses', async () => {
    const handler = ipcHandlers['task:worktreeMerge'];

    const resultPromise = handler({}, 'task-1', { noCommit: true });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Advance just shy of the timeout. The promise must still be pending.
    await vi.advanceTimersByTimeAsync(MERGE_TIMEOUT_MS - 1);

    // Race the promise against an immediately-resolved sentinel. If the
    // handler had already resolved, Promise.race would yield 'resolved'.
    const raced = await Promise.race([
      resultPromise.then(() => 'resolved'),
      Promise.resolve('pending'),
    ]);
    expect(raced).toBe('pending');

    // Push past the timeout and let it resolve so the test cleans up.
    await vi.advanceTimersByTimeAsync(1);
    const result = (await resultPromise) as {
      success: boolean;
      data: { status: string; timeout?: boolean };
    };
    expect(result.data.timeout).toBe(true);
    expect(result.data.status).toBe('unknown');
  });

  it('resolves with { success: true, status: "ok" } on normal successful completion (code === 0)', async () => {
    const handler = ipcHandlers['task:worktreeMerge'];

    const resultPromise = handler({}, 'task-1', { noCommit: true });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Emit a backend verification-contract progress event so the handler
    // sees `staged_files > 0` and picks the "stage-only success" branch
    // without running execFileSync itself (B6 path).
    const verificationEvent = JSON.stringify({
      type: 'progress',
      stage: 'verify',
      percent: 95,
      message: 'Post-merge verification',
      details: {
        verification: {
          staged_files: 2,
          merge_already_committed: false,
          conflict_markers_present: false,
          staged_diff_stat: ' file-a.ts | 3 +++\n file-b.ts | 2 +-\n',
        },
      },
    });
    fakeProcess.stdout.emit('data', Buffer.from(verificationEvent + '\n'));

    // Close with code 0 — the normal success path.
    fakeProcess.emit('close', 0, null);

    // Flush pending microtasks and any plan-update timers triggered by
    // withRetry's backoff.
    await vi.runAllTimersAsync();

    const result = (await resultPromise) as {
      success: boolean;
      data: { success: boolean; status: string; staged?: boolean };
    };

    // B1 contract: successful merge yields data.status 'ok' + data.success true.
    expect(result.success).toBe(true);
    expect(result.data.success).toBe(true);
    expect(result.data.status).toBe('ok');

    // Timeout must NOT have fired — kill should never have been invoked.
    expect(fakeProcess.kill).not.toHaveBeenCalled();
  });

  it('timer is cleared on process close — no late timeout trigger', async () => {
    const handler = ipcHandlers['task:worktreeMerge'];

    const resultPromise = handler({}, 'task-1', { noCommit: true });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Close before the timeout would fire.
    fakeProcess.emit('close', 0, null);

    // Advance well past MERGE_TIMEOUT_MS. The timeout handler must NOT run
    // (resolved === true is set synchronously inside handleProcessExit).
    await vi.advanceTimersByTimeAsync(MERGE_TIMEOUT_MS * 2);

    const result = (await resultPromise) as {
      data: { status: string; timeout?: boolean };
    };

    // Must be the success-path status, not the timeout's 'unknown'.
    expect(result.data.status).toBe('ok');
    expect(result.data.timeout).toBeUndefined();
  });
});
