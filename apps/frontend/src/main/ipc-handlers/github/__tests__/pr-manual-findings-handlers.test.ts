/**
 * Unit tests for pr-manual-findings-handlers.ts
 *
 * Covers:
 *   - add → list round trip
 *   - two synchronous adds produce unique IDs
 *   - update merges patchable fields, rejects immutable fields
 *   - delete removes a finding
 *   - chokidar watcher emits CHANGED with reason 'external' on add/change
 *   - chokidar watcher emits CHANGED with reason 'file-deleted' on unlink
 *   - malformed on-disk entries skipped + Sentry breadcrumb captured
 *   - empty / missing file returns an empty findings array
 *   - per-PR async mutex serializes 10 concurrent adds (no lost writes)
 *   - Haiku scrollback extractor — canned-JSON happy path, Zod-rejected
 *     malformed candidates dropped, ``` fences stripped before JSON.parse
 *
 * Strategy:
 *   - Hoisted mock ipcMain so we can invoke handlers like the renderer would
 *   - Mock 'electron', 'chokidar', '../utils/project-middleware', '../utils',
 *     '../../sentry', '@anthropic-ai/sdk', and the profile-manager so the
 *     module under test sees deterministic dependencies
 *   - Real filesystem under unique tempdirs per test for atomic-write paths
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import type { Project } from '../../../../shared/types';
import { IPC_CHANNELS } from '../../../../shared/constants';
import type { PRReviewFinding } from '../../../../shared/types/pr-review-comments';

// ───────────────────────────────────────────────────────────────────────────
// Hoisted mocks — must be vi.hoisted so they exist before vi.mock factories run
// ───────────────────────────────────────────────────────────────────────────

const mockIpcMain = vi.hoisted(() => {
  class HoistedMockIpcMain {
    handlers = new Map<string, Function>();

    handle(channel: string, handler: Function): void {
      this.handlers.set(channel, handler);
    }

    async invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = this.handlers.get(channel);
      if (!handler) {
        throw new Error(`No handler for channel: ${channel}`);
      }
      return handler({}, ...args);
    }

    reset(): void {
      this.handlers.clear();
    }
  }
  return new HoistedMockIpcMain();
});

const mockSafeBreadcrumb = vi.hoisted(() => vi.fn());

const projectRef: { current: Project | null } = { current: null };

// ───────────────────────────────────────────────────────────────────────────
// Module-level test doubles for the chokidar mock. These are referenced
// lazily by the vi.mock() factory callback — by the time chokidar is
// imported by the system-under-test, these declarations have executed.
// ───────────────────────────────────────────────────────────────────────────

class MockFSWatcher extends EventEmitter {
  close = vi.fn(() => Promise.resolve());
}

const createdWatchers: MockFSWatcher[] = [];

// ───────────────────────────────────────────────────────────────────────────
// Module mocks
// ───────────────────────────────────────────────────────────────────────────

class MockBrowserWindow {}

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  BrowserWindow: MockBrowserWindow,
  app: {
    getPath: vi.fn(() => '/tmp'),
    on: vi.fn(),
  },
}));

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn((_pattern: string, _opts: unknown) => {
      const w = new MockFSWatcher();
      createdWatchers.push(w);
      return w;
    }),
  },
}));

vi.mock('../utils/project-middleware', () => ({
  withProjectOrNull: async (
    _projectId: string,
    handler: (project: Project) => Promise<unknown>,
  ) => {
    if (!projectRef.current) {
      return null;
    }
    return handler(projectRef.current);
  },
}));

vi.mock('../utils', () => ({
  getGitHubConfig: vi.fn(() => null),
}));

vi.mock('../../../sentry', () => ({
  safeBreadcrumb: (...args: unknown[]) => mockSafeBreadcrumb(...args),
}));

// ───────────────────────────────────────────────────────────────────────────
// @anthropic-ai/sdk — hoisted mock so the SDK constructor is captured and the
// Haiku extractor tests can swap `messages.create`'s return value per-test.
//
// The mock returns a class with an instance-level `messages.create` spy, so:
//   - The SUT's `new Anthropic({...})` produces a usable client.
//   - Each test can call `mockMessagesCreate.mockResolvedValueOnce(...)` to
//     replay a canned response and observe how the extractor parses it.
//   - The `mockAnthropicConstructor` spy lets us assert apiKey/baseURL/timeout
//     wiring matches what the active API profile supplied.
// ───────────────────────────────────────────────────────────────────────────

const { mockMessagesCreate, mockAnthropicConstructor } = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockAnthropicConstructor: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockMessagesCreate };
    constructor(opts: unknown) {
      mockAnthropicConstructor(opts);
    }
  },
}));

// ───────────────────────────────────────────────────────────────────────────
// profile-manager — hoisted mock so the extractor's `loadProfilesFile()` call
// resolves to a deterministic profile with apiKey+baseUrl.
// ───────────────────────────────────────────────────────────────────────────

const mockLoadProfilesFile = vi.hoisted(() => vi.fn());

// Path is 3 ups from the test file (which lives under `__tests__/`) to reach
// `apps/frontend/src/main/services/profile/profile-manager`. `vi.mock` resolves
// the specifier relative to the file that calls it.
vi.mock('../../../services/profile/profile-manager', () => ({
  loadProfilesFile: mockLoadProfilesFile,
}));

// ───────────────────────────────────────────────────────────────────────────
// Test helpers
// ───────────────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function createProject(): Project {
  const projectPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'manual-findings-test-'),
  );
  tempDirs.push(projectPath);
  return {
    id: `project-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Test Project',
    path: projectPath,
    autoBuildPath: '.auto-claude',
    settings: {
      model: 'default',
      memoryBackend: 'file',
      linearSync: false,
      notifications: {
        onTaskComplete: false,
        onTaskFailed: false,
        onReviewNeeded: false,
        onPRReviewComplete: false,
        onClaudeSessionComplete: false,
        sound: false,
      },
      graphitiMcpEnabled: false,
      useClaudeMd: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createMockWindow(): BrowserWindow & {
  webContents: { send: ReturnType<typeof vi.fn> };
} {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  } as unknown as BrowserWindow & {
    webContents: { send: ReturnType<typeof vi.fn> };
  };
}

function getManualFindingsPath(project: Project, prNumber: number): string {
  return path.join(
    project.path,
    '.auto-claude',
    'github',
    'pr',
    `manual_findings_${prNumber}.json`,
  );
}

function makeValidPayload(
  overrides: Partial<PRReviewFinding> = {},
): Partial<PRReviewFinding> {
  return {
    severity: 'high',
    category: 'quality',
    title: 'Sample finding',
    description: 'Sample description',
    file: 'src/app.ts',
    line: 1,
    fixable: false,
    ...overrides,
  };
}

// Pre-existing __SENTRY__ global so we can inspect the breadcrumb call from
// loadManualFindingsSafe (which lives in shared/types and uses globalThis
// rather than `safeBreadcrumb`).
type SentryHub = { addBreadcrumb?: ReturnType<typeof vi.fn> };

function installSentryHubMock(): SentryHub {
  const hub: SentryHub = { addBreadcrumb: vi.fn() };
  (
    globalThis as { __SENTRY__?: { hub?: SentryHub } }
  ).__SENTRY__ = { hub };
  return hub;
}

function clearSentryHubMock(): void {
  delete (globalThis as { __SENTRY__?: unknown }).__SENTRY__;
}

// ───────────────────────────────────────────────────────────────────────────
// Test setup / teardown
// ───────────────────────────────────────────────────────────────────────────

type HandlersModule = typeof import('../pr-manual-findings-handlers');

describe('PR Manual Findings handlers', () => {
  let mod: HandlersModule;
  let project: Project;
  let mainWindow: BrowserWindow & {
    webContents: { send: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIpcMain.reset();
    createdWatchers.length = 0;
    clearSentryHubMock();

    project = createProject();
    projectRef.current = project;
    mainWindow = createMockWindow();

    // Re-import after vi.resetModules() (from setup.ts afterEach) so each test
    // gets fresh module-level state (locks map, watchers map, mainWindow accessor).
    mod = await import('../pr-manual-findings-handlers');
    mod.registerPRManualFindingsHandlers(() => mainWindow);
  });

  afterEach(async () => {
    // Stop any chokidar watchers the module started so they don't leak into
    // subsequent tests' module-level state.
    try {
      await mod.stopAllManualFindingsWatchers();
    } catch {
      // ignore — best-effort cleanup
    }
    projectRef.current = null;
    clearSentryHubMock();

    // Remove every tempdir the test created.
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore — tempdir may have already been cleaned by setup.ts
      }
    }
    tempDirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. ADD → LIST round trip
  // -------------------------------------------------------------------------
  describe('ADD → LIST', () => {
    it('returns the just-added finding via LIST', async () => {
      const added = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
        project.id,
        42,
        makeValidPayload({ title: 'My finding' }),
      )) as PRReviewFinding | null;

      expect(added).not.toBeNull();
      expect(added?.id).toMatch(/^manual-/);
      // ISO timestamp present
      expect(added?.authoredAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
      expect(added?.source).toBe('manual');
      expect(added?.title).toBe('My finding');

      const list = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        42,
      )) as PRReviewFinding[];

      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(added?.id);
      expect(list[0].title).toBe('My finding');
    });

    it('persists the finding to disk in the canonical location', async () => {
      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
        project.id,
        42,
        makeValidPayload(),
      );

      const filepath = getManualFindingsPath(project, 42);
      expect(fs.existsSync(filepath)).toBe(true);

      const onDisk = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as {
        prNumber: number;
        findings: unknown[];
        updatedAt: string;
      };
      expect(onDisk.prNumber).toBe(42);
      expect(onDisk.findings).toHaveLength(1);
      // updatedAt is fresh-stamped on every save
      expect(onDisk.updatedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    it('emits a CHANGED event with reason "add" after a successful add', async () => {
      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
        project.id,
        42,
        makeValidPayload(),
      );

      const sendCalls = mainWindow.webContents.send.mock.calls.filter(
        (call) =>
          call[0] === IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED,
      );
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0][1]).toBe(project.id);
      expect(sendCalls[0][2]).toBe(42);
      expect(sendCalls[0][3]).toBe('add');
    });

  });

  // -------------------------------------------------------------------------
  // 2. Two adds → unique IDs
  // -------------------------------------------------------------------------
  describe('unique ID generation', () => {
    it('produces two distinct IDs for two synchronous adds', async () => {
      const [a, b] = (await Promise.all([
        mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
          project.id,
          7,
          makeValidPayload({ title: 'A' }),
        ),
        mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
          project.id,
          7,
          makeValidPayload({ title: 'B' }),
        ),
      ])) as [PRReviewFinding | null, PRReviewFinding | null];

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a?.id).toBeDefined();
      expect(b?.id).toBeDefined();
      expect(a?.id).not.toBe(b?.id);
      expect(a?.id).toMatch(/^manual-/);
      expect(b?.id).toMatch(/^manual-/);
    });

    it('makeId is deterministic in shape: manual-<iso-with-dashes>-<6hex>', () => {
      const id = mod.makeId();
      // ISO datetime with `:` and `.` replaced by `-`, suffixed by 6 hex chars.
      // Example: manual-2026-05-20T08-12-34-320Z-9f3a2b
      expect(id).toMatch(/^manual-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. UPDATE — merges patch, rejects immutable fields
  // -------------------------------------------------------------------------
  describe('UPDATE', () => {
    async function addOne(
      prNumber = 100,
      overrides: Partial<PRReviewFinding> = {},
    ): Promise<PRReviewFinding> {
      const finding = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
        project.id,
        prNumber,
        makeValidPayload(overrides),
      )) as PRReviewFinding;
      if (!finding) {
        throw new Error('ADD returned null in test setup');
      }
      return finding;
    }

    it('merges patch fields into an existing finding', async () => {
      const added = await addOne(100, {
        severity: 'low',
        title: 'Original',
        description: 'Original description',
      });

      const updated = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_UPDATE,
        project.id,
        100,
        added.id,
        { severity: 'high', title: 'Updated' },
      )) as PRReviewFinding | null;

      expect(updated).not.toBeNull();
      expect(updated?.severity).toBe('high');
      expect(updated?.title).toBe('Updated');
      // Unchanged fields preserved
      expect(updated?.description).toBe('Original description');
      expect(updated?.file).toBe(added.file);
      expect(updated?.line).toBe(added.line);
    });

    it('silently drops attempts to overwrite immutable fields', async () => {
      const added = await addOne(100);

      const updated = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_UPDATE,
        project.id,
        100,
        added.id,
        // None of these may be mutated through UPDATE
        {
          id: 'spoofed-id',
          source: 'ai',
          authoredAt: '1970-01-01T00:00:00.000Z',
          authoredBy: 'attacker',
          // mutable patch alongside — proves the call still goes through
          severity: 'critical',
        } as Partial<PRReviewFinding>,
      )) as PRReviewFinding | null;

      expect(updated).not.toBeNull();
      expect(updated?.id).toBe(added.id);
      expect(updated?.source).toBe(added.source);
      expect(updated?.authoredAt).toBe(added.authoredAt);
      expect(updated?.authoredBy).toBe(added.authoredBy);
      // The mutable patch alongside the spoof still applied
      expect(updated?.severity).toBe('critical');
    });

    it('returns null when the target finding does not exist', async () => {
      const result = await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_UPDATE,
        project.id,
        100,
        'manual-does-not-exist-000000',
        { severity: 'high' },
      );

      expect(result).toBeNull();
    });

    it('emits a CHANGED event with reason "update" after a successful update', async () => {
      const added = await addOne(100);
      mainWindow.webContents.send.mockClear();

      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_UPDATE,
        project.id,
        100,
        added.id,
        { severity: 'high' },
      );

      const updateCalls = mainWindow.webContents.send.mock.calls.filter(
        (call) =>
          call[0] === IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED &&
          call[3] === 'update',
      );
      expect(updateCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 4. DELETE
  // -------------------------------------------------------------------------
  describe('DELETE', () => {
    it('removes the finding and returns true', async () => {
      const added = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
        project.id,
        77,
        makeValidPayload(),
      )) as PRReviewFinding;

      const deleted = await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_DELETE,
        project.id,
        77,
        added.id,
      );
      expect(deleted).toBe(true);

      const list = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        77,
      )) as PRReviewFinding[];
      expect(list).toEqual([]);
    });

    it('returns false when the finding does not exist', async () => {
      const result = await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_DELETE,
        project.id,
        77,
        'manual-not-here-zzzzzz',
      );
      expect(result).toBe(false);
    });

    it('emits a CHANGED event with reason "delete" after a successful delete', async () => {
      const added = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
        project.id,
        77,
        makeValidPayload(),
      )) as PRReviewFinding;
      mainWindow.webContents.send.mockClear();

      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_DELETE,
        project.id,
        77,
        added.id,
      );

      const deleteCalls = mainWindow.webContents.send.mock.calls.filter(
        (call) =>
          call[0] === IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED &&
          call[3] === 'delete',
      );
      expect(deleteCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Chokidar watcher — external write
  // -------------------------------------------------------------------------
  describe('chokidar watcher', () => {
    async function importChokidarMock(): Promise<{
      watch: ReturnType<typeof vi.fn>;
    }> {
      const chokidar = (await import('chokidar')) as unknown as {
        default: { watch: ReturnType<typeof vi.fn> };
      };
      return { watch: chokidar.default.watch };
    }

    it('emits CHANGED with reason "external" on filesystem add/change', async () => {
      // LIST lazy-starts the watcher for this project.
      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        7,
      );

      // chokidar.watch should have been called at least once for this project.
      expect(createdWatchers.length).toBeGreaterThanOrEqual(1);
      const watcher = createdWatchers[createdWatchers.length - 1];

      // The 'change' handler routes the basename → prNumber, then emits.
      const fakePath = path.join(
        project.path,
        '.auto-claude',
        'github',
        'pr',
        'manual_findings_7.json',
      );
      mainWindow.webContents.send.mockClear();
      watcher.emit('change', fakePath);

      const changeCalls = mainWindow.webContents.send.mock.calls.filter(
        (call) =>
          call[0] === IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED &&
          call[3] === 'external',
      );
      expect(changeCalls).toHaveLength(1);
      expect(changeCalls[0][1]).toBe(project.id);
      expect(changeCalls[0][2]).toBe(7);

      // 'add' should route to the same 'external' reason
      mainWindow.webContents.send.mockClear();
      watcher.emit('add', fakePath);
      const addCalls = mainWindow.webContents.send.mock.calls.filter(
        (call) =>
          call[0] === IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED &&
          call[3] === 'external',
      );
      expect(addCalls).toHaveLength(1);
    });

    it('emits CHANGED with reason "file-deleted" on filesystem unlink', async () => {
      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        12,
      );
      const watcher = createdWatchers[createdWatchers.length - 1];

      mainWindow.webContents.send.mockClear();
      const fakePath = path.join(
        project.path,
        '.auto-claude',
        'github',
        'pr',
        'manual_findings_12.json',
      );
      watcher.emit('unlink', fakePath);

      const calls = mainWindow.webContents.send.mock.calls.filter(
        (call) =>
          call[0] === IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe(project.id);
      expect(calls[0][2]).toBe(12);
      expect(calls[0][3]).toBe('file-deleted');
    });

    it('silently ignores files that match the glob but not the canonical regex', async () => {
      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        9,
      );
      const watcher = createdWatchers[createdWatchers.length - 1];

      mainWindow.webContents.send.mockClear();
      // A stray file matching the glob but not the regex shouldn't emit anything.
      watcher.emit(
        'change',
        path.join(
          project.path,
          '.auto-claude',
          'github',
          'pr',
          'manual_findings_backup.json',
        ),
      );

      const calls = mainWindow.webContents.send.mock.calls.filter(
        (call) =>
          call[0] === IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED,
      );
      expect(calls).toHaveLength(0);
    });

    it('uses chokidar.watch with awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }', async () => {
      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        99,
      );

      const { watch } = await importChokidarMock();
      // The first watch call carries the awaitWriteFinish config we expect.
      const opts = watch.mock.calls[0]?.[1] as
        | {
            persistent?: boolean;
            ignoreInitial?: boolean;
            awaitWriteFinish?: {
              stabilityThreshold?: number;
              pollInterval?: number;
            };
          }
        | undefined;
      expect(opts?.persistent).toBe(true);
      expect(opts?.ignoreInitial).toBe(true);
      expect(opts?.awaitWriteFinish?.stabilityThreshold).toBe(300);
      expect(opts?.awaitWriteFinish?.pollInterval).toBe(100);
    });

    it('LIST lazy-starts the watcher and a second LIST does not duplicate it', async () => {
      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        1,
      );
      const { watch } = await importChokidarMock();
      const callsAfterFirst = watch.mock.calls.length;

      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        1,
      );
      const callsAfterSecond = watch.mock.calls.length;

      expect(callsAfterFirst).toBe(1);
      expect(callsAfterSecond).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Malformed entries — skipped with Sentry breadcrumb
  // -------------------------------------------------------------------------
  describe('malformed entries', () => {
    it('skips invalid entries during LIST and keeps the valid ones', async () => {
      const hub = installSentryHubMock();

      // Write a file with one invalid + two valid findings on disk directly,
      // bypassing the ADD handler so we can inject malformed data.
      const prDir = path.join(
        project.path,
        '.auto-claude',
        'github',
        'pr',
      );
      fs.mkdirSync(prDir, { recursive: true });
      const filepath = path.join(prDir, 'manual_findings_55.json');
      fs.writeFileSync(
        filepath,
        JSON.stringify(
          {
            prNumber: 55,
            repo: 'owner/test',
            updatedAt: '2026-05-20T00:00:00.000Z',
            findings: [
              {
                id: 'manual-valid-1',
                severity: 'high',
                category: 'quality',
                title: 'Valid finding 1',
                description: 'desc',
                file: 'a.ts',
                line: 1,
                fixable: false,
              },
              // Invalid — missing required fields (severity, category, etc.)
              {
                id: 'manual-invalid',
                title: 'Missing required fields',
              },
              {
                id: 'manual-valid-2',
                severity: 'low',
                category: 'style',
                title: 'Valid finding 2',
                description: 'desc',
                file: 'b.ts',
                line: 2,
                fixable: false,
              },
            ],
          },
          null,
          2,
        ),
      );

      const list = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        55,
      )) as PRReviewFinding[];

      expect(list).toHaveLength(2);
      expect(list.map((f) => f.id)).toEqual([
        'manual-valid-1',
        'manual-valid-2',
      ]);

      // Sentry breadcrumb recorded under category 'manual-findings'
      expect(hub.addBreadcrumb).toHaveBeenCalled();
      const breadcrumb = hub.addBreadcrumb?.mock.calls[0]?.[0] as
        | { category?: string; message?: string; level?: string }
        | undefined;
      expect(breadcrumb?.category).toBe('manual-findings');
      expect(breadcrumb?.message).toBe('Skipped invalid entry');
      expect(breadcrumb?.level).toBe('warning');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Empty / missing file
  // -------------------------------------------------------------------------
  describe('empty / missing file', () => {
    it('LIST returns an empty array when no file exists yet', async () => {
      const list = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        4242,
      )) as PRReviewFinding[];

      expect(list).toEqual([]);
    });

    it('loadManualFindings returns { findings: [] } envelope for missing file', () => {
      const envelope = mod.loadManualFindings(project, 4242);

      expect(envelope.findings).toEqual([]);
      expect(envelope.prNumber).toBe(4242);
    });

    it('LIST returns an empty array when the file exists but is corrupted JSON', async () => {
      const prDir = path.join(
        project.path,
        '.auto-claude',
        'github',
        'pr',
      );
      fs.mkdirSync(prDir, { recursive: true });
      fs.writeFileSync(
        path.join(prDir, 'manual_findings_4242.json'),
        '{ not valid json',
      );

      const list = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        4242,
      )) as PRReviewFinding[];

      expect(list).toEqual([]);
      // Corrupt-file path logs a breadcrumb via safeBreadcrumb (not via
      // globalThis.__SENTRY__, which is the per-entry path).
      expect(mockSafeBreadcrumb).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 8. Mutex — 10 concurrent adds, no lost writes
  // -------------------------------------------------------------------------
  describe('per-PR async mutex', () => {
    it('serializes 10 concurrent ADDs without losing writes', async () => {
      const adds = Array.from({ length: 10 }, (_, i) =>
        mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
          project.id,
          500,
          makeValidPayload({ title: `Concurrent ${i}` }),
        ),
      );
      const results = (await Promise.all(adds)) as Array<
        PRReviewFinding | null
      >;

      // Every ADD resolved with a non-null finding.
      for (const r of results) {
        expect(r).not.toBeNull();
        expect(r?.id).toMatch(/^manual-/);
      }

      // All 10 ids are unique.
      const ids = results.map((r) => r?.id);
      expect(new Set(ids).size).toBe(10);

      // The on-disk file contains all 10 entries — proves no read-modify-write
      // races dropped a previous write.
      const list = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
        project.id,
        500,
      )) as PRReviewFinding[];

      expect(list).toHaveLength(10);
      expect(new Set(list.map((f) => f.id)).size).toBe(10);
      // Every title authored under this PR is present.
      const titles = new Set(list.map((f) => f.title));
      for (let i = 0; i < 10; i++) {
        expect(titles.has(`Concurrent ${i}`)).toBe(true);
      }
    });

  });

  // -------------------------------------------------------------------------
  // 9. Haiku scrollback extractor — canned-JSON, Zod validation, fence stripping
  // -------------------------------------------------------------------------
  //
  // Strategy: stub `@anthropic-ai/sdk` so `client.messages.create()` returns a
  // pre-shaped response, register the handlers with a terminal-buffer accessor
  // that yields a deterministic transcript, then invoke the EXTRACT IPC
  // handler and assert what came back through Zod validation.
  describe('Haiku scrollback extractor', () => {
    /**
     * Build an Anthropic-style `messages.create` response where the first text
     * block is exactly `body`. The model returns the text we'd parse back into
     * candidate findings — this helper lets each test pin that text per case.
     */
    function makeAnthropicResponse(body: string) {
      return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: body }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }

    /**
     * A fully-validated candidate finding shape the extractor would emit.
     * The `id`, `source`, `authoredAt`, and `authoredBy` fields are stamped
     * server-side by the extractor — so canned JSON omits them and the SUT
     * is expected to fill them in.
     */
    function validCandidate(overrides: Record<string, unknown> = {}) {
      return {
        severity: 'high',
        category: 'quality',
        title: 'Race condition in worker',
        description: 'The mutex is released before the read completes.',
        file: 'src/foo/bar.ts',
        line: 42,
        fixable: false,
        ...overrides,
      };
    }

    beforeEach(() => {
      // Reset the SDK + profile mocks so each test starts from a clean slate.
      mockMessagesCreate.mockReset();
      mockAnthropicConstructor.mockReset();
      mockLoadProfilesFile.mockReset();

      // Default profile resolves to a usable api-profile shape so the
      // extractor's `getActiveAPIProfile()` succeeds. Tests that exercise the
      // "no active profile" branch override this per-test.
      mockLoadProfilesFile.mockResolvedValue({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Test Profile',
            apiKey: 'sk-ant-test-12345',
            baseUrl: 'https://api.anthropic.com',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });

      // Re-register the handlers with a terminal-buffer accessor so the
      // EXTRACT handler can read transcripts. The parent `beforeEach`
      // registered with no accessor, which makes the extractor return `[]`
      // for every call — we override that here.
      mod.registerPRManualFindingsHandlers(
        () => mainWindow,
        (terminalId: string) => {
          // Return a deterministic, non-empty transcript when the test asks
          // for `terminal-1`, otherwise `null` (treated as "no buffer").
          if (terminalId === 'terminal-1') {
            return 'I noticed a race condition in src/foo/bar.ts at line 42';
          }
          if (terminalId === 'terminal-empty') {
            return '';
          }
          return null;
        },
      );
    });

    // -------------------------------------------------------------------------
    // Happy path — canned JSON parses cleanly through Zod
    // -------------------------------------------------------------------------
    it('parses canned JSON candidates through Zod into validated findings', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeAnthropicResponse(
          JSON.stringify([
            validCandidate({ title: 'A' }),
            validCandidate({ title: 'B', file: 'src/foo/qux.ts', line: 7 }),
          ]),
        ),
      );

      const result = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-1',
        123,
      )) as PRReviewFinding[];

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('A');
      expect(result[1].title).toBe('B');
      // Server-stamped fields are present and consistent.
      for (const f of result) {
        expect(f.source).toBe('terminal');
        expect(f.authoredBy).toBe('terminal-extraction');
        expect(f.id).toMatch(/^manual-/);
        // ISO timestamp shape — chronological + parseable.
        expect(f.authoredAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        );
      }
    });

    it('passes the active profile credentials to the Anthropic client', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeAnthropicResponse(JSON.stringify([])),
      );

      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-1',
        123,
      );

      // Anthropic({apiKey, baseURL, timeout, maxRetries}) was wired exactly
      // as the spec requires: explicit apiKey + baseURL from the active
      // profile, hard timeout, zero auto-retries (the renderer drives retry).
      expect(mockAnthropicConstructor).toHaveBeenCalledTimes(1);
      const opts = mockAnthropicConstructor.mock.calls[0]?.[0] as {
        apiKey?: string;
        baseURL?: string;
        timeout?: number;
        maxRetries?: number;
      };
      expect(opts?.apiKey).toBe('sk-ant-test-12345');
      expect(opts?.baseURL).toBe('https://api.anthropic.com');
      expect(opts?.timeout).toBe(20_000);
      expect(opts?.maxRetries).toBe(0);
    });

    it('pins the model to claude-haiku-4-5 regardless of profile', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeAnthropicResponse(JSON.stringify([])),
      );

      await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-1',
        123,
      );

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const req = mockMessagesCreate.mock.calls[0]?.[0] as {
        model?: string;
        max_tokens?: number;
      };
      expect(req?.model).toBe('claude-haiku-4-5');
      // Modest cap so a runaway model doesn't hallucinate a giant list.
      expect(req?.max_tokens).toBe(4096);
    });

    // -------------------------------------------------------------------------
    // Malformed candidates dropped per-entry (does not poison the batch)
    // -------------------------------------------------------------------------
    it('discards malformed candidates and keeps the valid ones', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeAnthropicResponse(
          JSON.stringify([
            // Valid
            validCandidate({ title: 'Good 1' }),
            // Invalid — severity not in the enum
            { ...validCandidate(), severity: 'nuclear' },
            // Invalid — missing required fields entirely
            { title: 'Missing everything else' },
            // Invalid — wrong category enum
            { ...validCandidate(), category: 'made-up-category' },
            // Invalid — line is a string, schema requires int
            { ...validCandidate(), line: 'not-a-number' },
            // Valid
            validCandidate({ title: 'Good 2', line: 99 }),
          ]),
        ),
      );

      const result = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-1',
        123,
      )) as PRReviewFinding[];

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.title)).toEqual(['Good 1', 'Good 2']);
    });

    it('returns [] when the model emits a non-array top-level shape', async () => {
      // Model occasionally emits an object instead of an array when confused.
      // The extractor should not throw — it should return [] and log a
      // breadcrumb (verified by other tests).
      mockMessagesCreate.mockResolvedValueOnce(
        makeAnthropicResponse(
          JSON.stringify({ findings: [validCandidate()] }),
        ),
      );

      const result = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-1',
        123,
      )) as PRReviewFinding[];

      expect(result).toEqual([]);
    });

    it('returns [] when the model output is not JSON at all', async () => {
      mockMessagesCreate.mockResolvedValueOnce(
        makeAnthropicResponse('This is not JSON, just plain text.'),
      );

      const result = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-1',
        123,
      )) as PRReviewFinding[];

      expect(result).toEqual([]);
      // The non-JSON path is breadcrumbed via safeBreadcrumb so we can find it
      // in Sentry under the manual-findings category.
      expect(mockSafeBreadcrumb).toHaveBeenCalled();
      const breadcrumbCalls = mockSafeBreadcrumb.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { category?: string } | undefined;
          return arg?.category === 'manual-findings';
        },
      );
      expect(breadcrumbCalls.length).toBeGreaterThanOrEqual(1);
    });

    // -------------------------------------------------------------------------
    // ``` fence stripping
    // -------------------------------------------------------------------------
    describe('``` fence stripping', () => {
      it('strips ```json fences before JSON.parse', async () => {
        const wrapped = [
          '```json',
          JSON.stringify([validCandidate({ title: 'Fenced' })]),
          '```',
        ].join('\n');
        mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(wrapped));

        const result = (await mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
          'terminal-1',
          123,
        )) as PRReviewFinding[];

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('Fenced');
      });

      it('strips bare ``` fences (no language tag) before JSON.parse', async () => {
        const wrapped = [
          '```',
          JSON.stringify([validCandidate({ title: 'Bare-fenced' })]),
          '```',
        ].join('\n');
        mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(wrapped));

        const result = (await mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
          'terminal-1',
          123,
        )) as PRReviewFinding[];

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('Bare-fenced');
      });

      it('strips ```JSON (uppercase) fences before JSON.parse', async () => {
        const wrapped = [
          '```JSON',
          JSON.stringify([validCandidate({ title: 'Upper-fenced' })]),
          '```',
        ].join('\n');
        mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(wrapped));

        const result = (await mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
          'terminal-1',
          123,
        )) as PRReviewFinding[];

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('Upper-fenced');
      });

      it('passes raw JSON through unchanged when no fence is present', async () => {
        // Smoke check — the strip regex must not mangle a well-formed array.
        mockMessagesCreate.mockResolvedValueOnce(
          makeAnthropicResponse(
            JSON.stringify([validCandidate({ title: 'No-fence' })]),
          ),
        );

        const result = (await mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
          'terminal-1',
          123,
        )) as PRReviewFinding[];

        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('No-fence');
      });
    });

    // -------------------------------------------------------------------------
    // Empty / missing transcript paths
    // -------------------------------------------------------------------------
    it('returns [] without calling the model when the terminal has no buffer', async () => {
      const result = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-does-not-exist',
        123,
      )) as PRReviewFinding[];

      expect(result).toEqual([]);
      // Crucially the model was never called — no wasted API spend on a
      // terminal that has nothing to extract from.
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it('returns [] without calling the model when the transcript is whitespace-only', async () => {
      const result = (await mockIpcMain.invokeHandler(
        IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
        'terminal-empty',
        123,
      )) as PRReviewFinding[];

      expect(result).toEqual([]);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // No active API profile — extractor throws so the renderer can toast
    // -------------------------------------------------------------------------
    it('throws when no active API profile is configured', async () => {
      mockLoadProfilesFile.mockResolvedValueOnce({
        activeProfileId: null,
        profiles: [],
      });

      // The renderer-side invoke path returns the rejection; surface it here
      // through .rejects.toThrow to match the spec error message.
      await expect(
        mockIpcMain.invokeHandler(
          IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
          'terminal-1',
          123,
        ),
      ).rejects.toThrow(/No active API profile/i);

      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });
  });
});
