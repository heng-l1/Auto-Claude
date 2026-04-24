/**
 * Unit tests for mcp-prewarm.ts
 *
 * Verifies the stdio MCP pre-warm service at Electron startup:
 *  - reads and filters the .claude.json config safely
 *  - spawns only explicit stdio-type servers with the augmented env
 *  - gracefully escalates SIGTERM -> SIGKILL after the warm-up window,
 *    with an exit-tracking short-circuit on the SIGKILL branch
 *  - swallows every failure class (ENOENT, malformed JSON, missing config)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock refs: vi.mock factories are hoisted above imports, but
// closure variables they reference are not. vi.hoisted() evaluates the
// factory early so these mocks exist when the mock factories run.
const {
  spawnMock,
  existsSyncMock,
  readFileSyncMock,
  homedirMock,
  getAugmentedEnvMock,
  isWindowsMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  homedirMock: vi.fn(),
  getAugmentedEnvMock: vi.fn(),
  isWindowsMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock('node:os', () => ({
  homedir: homedirMock,
}));

vi.mock('../../env-utils', () => ({
  getAugmentedEnv: getAugmentedEnvMock,
}));

vi.mock('../../platform', () => ({
  isWindows: isWindowsMock,
}));

import { preWarmStdioMcpServers } from '../mcp-prewarm';

/**
 * Mocked child returned by `spawn()`. Captures the 'error' and 'exit'
 * callbacks the service registers so tests can simulate runtime events
 * (graceful exit, ENOENT, etc.).
 */
interface MockChild {
  pid: number;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  stdin: { end: ReturnType<typeof vi.fn> };
  _errorCb?: () => void;
  _exitCb?: () => void;
}

function createMockChild(pid = 1234): MockChild {
  const child: MockChild = {
    pid,
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
    killed: false,
    stdin: { end: vi.fn() },
  };
  child.on.mockImplementation((event: string, cb: () => void) => {
    if (event === 'error') {
      child._errorCb = cb;
    }
    return child;
  });
  child.once.mockImplementation((event: string, cb: () => void) => {
    if (event === 'exit') {
      child._exitCb = cb;
    }
    return child;
  });
  return child;
}

describe('preWarmStdioMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Defaults: login-shell augmented env, Unix platform, present config file.
    getAugmentedEnvMock.mockReturnValue({
      PATH: '/mock/augmented:/usr/bin',
      HOME: '/mock/home',
    });
    homedirMock.mockReturnValue('/mock/home');
    isWindowsMock.mockReturnValue(false);
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('{}');
    spawnMock.mockImplementation(() => createMockChild());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when config has no stdio MCP servers', async () => {
    // Case A: config object does not include mcpServers at all.
    readFileSyncMock.mockReturnValue('{}');
    await preWarmStdioMcpServers();
    expect(spawnMock).not.toHaveBeenCalled();

    // Case B: mcpServers present but empty.
    readFileSyncMock.mockReturnValue(JSON.stringify({ mcpServers: {} }));
    await preWarmStdioMcpServers();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns each stdio MCP server exactly once with augmented env', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'server-a': {
            type: 'stdio',
            command: '/bin/server-a',
            args: ['--verbose'],
          },
          'server-b': {
            type: 'stdio',
            command: '/bin/server-b',
          },
          'server-c': {
            type: 'stdio',
            command: '/bin/server-c',
            env: { CUSTOM_VAR: 'override' },
          },
        },
      })
    );

    await preWarmStdioMcpServers();

    expect(spawnMock).toHaveBeenCalledTimes(3);

    // Every spawn call must receive an env that includes the augmented PATH.
    for (const call of spawnMock.mock.calls) {
      const options = call[2] as { env: Record<string, string> };
      expect(options.env.PATH).toBe('/mock/augmented:/usr/bin');
    }

    // server-a forwards its args; server-b uses [] when args are missing.
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/server-a',
      ['--verbose'],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
    );
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/server-b',
      [],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
    );

    // server-c: per-server env overrides merge on top of augmented env.
    const serverCCall = spawnMock.mock.calls.find((c) => c[0] === '/bin/server-c');
    expect(serverCCall).toBeDefined();
    const serverCOptions = serverCCall?.[2] as { env: Record<string, string> };
    expect(serverCOptions.env.CUSTOM_VAR).toBe('override');
    expect(serverCOptions.env.PATH).toBe('/mock/augmented:/usr/bin');
  });

  it('skips non-stdio server types (http, sse)', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'stdio-server': { type: 'stdio', command: '/bin/stdio' },
          'http-server': { type: 'http', command: '/bin/http' },
          'sse-server': { type: 'sse', command: '/bin/sse' },
          // type === 'command' is strictly filtered: service requires
          // explicit `type === 'stdio'` opt-in.
          'command-server': { type: 'command', command: '/bin/cmd' },
          // No `type` field at all: also skipped.
          'no-type-server': { command: '/bin/notype' },
        },
      })
    );

    await preWarmStdioMcpServers();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/stdio',
      [],
      expect.any(Object)
    );
  });

  it('sends SIGTERM to servers still running after the warmup window, then SIGKILLs only survivors whose exit event did NOT fire', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'survivor-a': { type: 'stdio', command: '/bin/a' },
          'survivor-b': { type: 'stdio', command: '/bin/b' },
          'exits-early': { type: 'stdio', command: '/bin/c' },
        },
      })
    );

    // Track each spawned child so tests can inspect kill calls and trigger
    // the captured 'exit' callback on demand.
    const children: MockChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild(1000 + children.length);
      children.push(child);
      return child;
    });

    await preWarmStdioMcpServers();
    expect(children.length).toBe(3);

    // Warm-up window: advance past the 10s SIGTERM timer.
    vi.advanceTimersByTime(10_000);

    // Every survivor (all 3 at this point) should receive SIGTERM on Unix.
    for (const child of children) {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    }

    // Simulate one child exiting from SIGTERM inside the escalation window.
    // Firing the captured 'exit' callback flips entry.hasExited = true
    // inside the service closure, which must short-circuit SIGKILL.
    const earlyExit = children[2];
    expect(earlyExit).toBeDefined();
    if (!earlyExit) return;
    expect(earlyExit._exitCb).toBeDefined();
    earlyExit._exitCb?.();

    // Advance past the 12s SIGKILL deadline.
    vi.advanceTimersByTime(2_000);

    // Survivors still running receive SIGKILL.
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(children[1]?.kill).toHaveBeenCalledWith('SIGKILL');

    // The child whose 'exit' already fired must NOT receive SIGKILL —
    // this asserts the exit-tracking short-circuit.
    const earlyExitSigkills = earlyExit.kill.mock.calls.filter(
      (args) => args[0] === 'SIGKILL'
    );
    expect(earlyExitSigkills).toHaveLength(0);
  });

  it('swallows spawn errors silently', async () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op — silences console.warn in tests
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'bad-server': { type: 'stdio', command: '/bin/bad' },
        },
      })
    );

    // Case A: spawn throws synchronously. The outer try/catch swallows,
    // the promise still resolves, and at most one console.warn is emitted.
    spawnMock.mockImplementation(() => {
      throw new Error('spawn EACCES');
    });
    await expect(preWarmStdioMcpServers()).resolves.toBeUndefined();
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(1);

    warnSpy.mockClear();

    // Case B: spawn returns a child that later emits 'error'.
    // The in-line child.on('error', () => {}) handler swallows the event.
    const errorChild = createMockChild();
    spawnMock.mockImplementation(() => errorChild);
    await expect(preWarmStdioMcpServers()).resolves.toBeUndefined();
    // Trigger the captured 'error' callback — must NOT throw, must NOT warn.
    expect(errorChild._errorCb).toBeDefined();
    expect(() => errorChild._errorCb?.()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('no-ops when the config file does not exist or is malformed', async () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op — silences console.warn in tests
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Case A: config file missing — early return, no read attempt.
    existsSyncMock.mockReturnValue(false);
    await expect(preWarmStdioMcpServers()).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    // Case B: config file present but not valid JSON — inner try/catch
    // swallows the parse error silently.
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('this is { not valid json');
    await expect(preWarmStdioMcpServers()).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
