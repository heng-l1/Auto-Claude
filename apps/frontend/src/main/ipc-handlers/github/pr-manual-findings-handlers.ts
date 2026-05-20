/**
 * GitHub PR Manual Findings IPC handlers
 *
 * Handles user- and terminal-authored "manual" findings stored alongside the
 * AI-generated `review_<prNumber>.json`. Manual findings are persisted at
 *   `.auto-claude/github/pr/manual_findings_<prNumber>.json`
 * and merged into the post-review payload at post time by `pr-handlers.ts`.
 *
 * Surface:
 *   • LIST   — return all manual findings for a PR
 *   • ADD    — append a new manual finding (validated via Zod)
 *   • UPDATE — patch mutable fields on an existing finding
 *   • DELETE — remove a finding by id
 *
 * Concurrency:
 *   A per-(projectId:prNumber) async mutex serializes all mutating handlers so
 *   concurrent IPC calls cannot race on the read-modify-write cycle. Reads
 *   (LIST) skip the lock — `writeFileAtomicSync` guarantees the on-disk file
 *   is never partially observable.
 *
 * IDs:
 *   `manual-<ISO-with-dashes>-<6-char-hex>` — the millisecond timestamp gives
 *   chronological ordering while the random hex suffix prevents collisions
 *   when two ADDs land in the same tick.
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { randomBytes } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { IPC_CHANNELS } from '../../../shared/constants';
import { withProjectOrNull } from './utils/project-middleware';
import { getGitHubConfig } from './utils';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { createContextLogger } from './utils/logger';
import { safeBreadcrumb } from '../../sentry';
import { stripAnsiCodes } from '../../../shared/utils/ansi-sanitizer';
import { loadProfilesFile } from '../../services/profile/profile-manager';
import type { Project } from '../../../shared/types';
import type { APIProfile } from '../../../shared/types/profile';
import {
  PRReviewFindingSchema,
  loadManualFindingsSafe,
} from '../../../shared/types/pr-review-comments';
import type { PRReviewFinding } from '../../../shared/types/pr-review-comments';

const { debug: debugLog } = createContextLogger('PR Manual Findings');

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Envelope persisted to `manual_findings_<prNumber>.json`. Mirrors the
 * `ManualFindingsFileSchema` Zod shape declared in `pr-review-comments.ts`,
 * but kept as a local TS type so the handler module is not coupled to the
 * exact runtime schema (the schema is used only for entry-level validation
 * via `loadManualFindingsSafe`).
 */
export interface ManualFindingsFile {
  prNumber: number;
  repo: string;
  updatedAt: string;
  findings: PRReviewFinding[];
}

/**
 * Reasons the renderer is notified of a change. `'external'` and
 * `'file-deleted'` are emitted by the chokidar watcher (added in a later
 * subtask) — `'add' | 'update' | 'delete'` are emitted by the IPC handlers
 * below right after a successful in-app mutation.
 */
export type ManualFindingsChangeReason =
  | 'add'
  | 'update'
  | 'delete'
  | 'external'
  | 'file-deleted';

/**
 * Fields the renderer may patch on UPDATE. Everything else on
 * `PRReviewFinding` is either server-generated (`id`, `authoredAt`) or part
 * of the audit trail (`source`, `authoredBy`) and is therefore silently
 * dropped from any incoming patch.
 */
const PATCHABLE_FIELDS = [
  'severity',
  'category',
  'title',
  'description',
  'file',
  'line',
  'endLine',
  'suggestedFix',
  'fixable',
] as const;
type PatchableField = (typeof PATCHABLE_FIELDS)[number];

/* -------------------------------------------------------------------------- */
/* Per-PR async mutex                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lock chain keyed by `${projectId}:${prNumber}`. Each entry holds the tail
 * of the currently outstanding promise chain for that PR; new operations
 * attach to the tail via `.then(fn, fn)` so they always run sequentially,
 * even when a prior op rejected.
 */
const locks = new Map<string, Promise<unknown>>();

/**
 * Serialize an async operation against a key. Concurrent operations on
 * different keys do not block each other — only operations sharing the same
 * key are queued.
 *
 * Implementation notes:
 *   - `.then(fn, fn)` lets the chain continue even when the previous op
 *     rejected (a single bad request must not poison subsequent ones).
 *   - The `.finally(() => locks.delete(...))` cleanup runs after the chain
 *     resolves so the Map does not grow unbounded as PRs come and go.
 *   - The `locks.get(key) === next` guard prevents the cleanup from clobbering
 *     a later op that already replaced the tail.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn) as Promise<T>;
  locks.set(key, next);
  next.finally(() => {
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  });
  return next;
}

/* -------------------------------------------------------------------------- */
/* ID generation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Generate a manual-finding id of the form `manual-<ISO-with-dashes>-<6char>`.
 *
 * Example: `manual-2026-05-20T08-12-34-320Z-9f3a2b`
 *
 * - The ISO timestamp gives natural chronological sorting and human-readable
 *   debugging information.
 * - `:` and `.` are replaced with `-` so the id stays safe to use in any
 *   filesystem / URL path that might inadvertently see it.
 * - 6 hex chars = 16M values per millisecond, sufficient to defeat collisions
 *   for any plausible burst of ADDs in a single tick.
 */
export function makeId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(3).toString('hex');
  return `manual-${iso}-${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the absolute path of the manual findings file for a given PR. The
 * file lives next to the AI review at `.auto-claude/github/pr/`.
 */
function getManualFindingsPath(project: Project, prNumber: number): string {
  return path.join(
    project.path,
    '.auto-claude',
    'github',
    'pr',
    `manual_findings_${prNumber}.json`,
  );
}

/**
 * Load the manual findings envelope for a PR.
 *
 * Returns an empty-findings envelope when the file is missing or unreadable
 * so callers never have to special-case "first add" / "corrupt JSON" /
 * "permissions error". Per-entry validation in `loadManualFindingsSafe`
 * means a single bad entry does not nuke the whole list — invalid entries
 * record a Sentry breadcrumb and are silently skipped.
 */
export function loadManualFindings(
  project: Project,
  prNumber: number,
): ManualFindingsFile {
  const filepath = getManualFindingsPath(project, prNumber);
  if (!fs.existsSync(filepath)) {
    return { prNumber, repo: '', updatedAt: '', findings: [] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Partial<ManualFindingsFile>;
    const findings = loadManualFindingsSafe(raw);
    return {
      prNumber: typeof raw?.prNumber === 'number' ? raw.prNumber : prNumber,
      repo: typeof raw?.repo === 'string' ? raw.repo : '',
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
      findings,
    };
  } catch (error) {
    debugLog('Failed to load manual findings file', {
      prNumber,
      error: error instanceof Error ? error.message : error,
    });
    safeBreadcrumb({
      category: 'manual-findings',
      level: 'warning',
      message: 'Failed to read manual findings file',
      data: {
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return { prNumber, repo: '', updatedAt: '', findings: [] };
  }
}

/**
 * Atomically persist the manual findings envelope for a PR.
 *
 * Refreshes `updatedAt` to the current ISO timestamp on every write and
 * backfills `repo` from the project's GitHub config when the envelope does
 * not already carry one. `writeFileAtomicSync` writes to a temp file then
 * renames over the target, so a concurrent reader never sees a partial JSON.
 */
export function saveManualFindings(
  project: Project,
  prNumber: number,
  file: ManualFindingsFile,
): void {
  const filepath = getManualFindingsPath(project, prNumber);
  const dir = path.dirname(filepath);
  // writeFileAtomicSync does not create parent dirs — do it ourselves.
  fs.mkdirSync(dir, { recursive: true });

  const repo = file.repo || getGitHubConfig(project)?.repo || '';
  const envelope: ManualFindingsFile = {
    prNumber,
    repo,
    updatedAt: new Date().toISOString(),
    findings: file.findings,
  };
  writeFileAtomicSync(filepath, JSON.stringify(envelope, null, 2));
}

/* -------------------------------------------------------------------------- */
/* IPC change-event emission                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Set during `registerPRManualFindingsHandlers` and used by `emitChanged` to
 * find the active BrowserWindow at the moment a change is announced. Stored
 * as a getter (not a captured `BrowserWindow` instance) so a recreated window
 * after dev-mode reload is still reachable.
 */
let mainWindowAccessor: (() => BrowserWindow | null) | null = null;

/**
 * Set during `registerPRManualFindingsHandlers` and used by the Haiku
 * scrollback extractor to fetch a terminal's last-100KB output buffer.
 *
 * Stored as a getter (not a captured buffer string) so the extractor reads
 * the current contents at invoke time — not whatever was buffered when the
 * handlers were registered. Returns `null` when the terminal does not exist
 * or has no buffer (treated as "transcript not available" by the extractor).
 *
 * Optional in the registration signature so existing call sites (and unit
 * tests that only exercise LIST/ADD/UPDATE/DELETE) do not have to wire it.
 */
let terminalOutputBufferAccessor:
  | ((terminalId: string) => string | null)
  | null = null;

/**
 * Fire a `GITHUB_PR_MANUAL_FINDINGS_CHANGED` event so the renderer's
 * pr-review-store can re-fetch (or, on `'file-deleted'`, clear) its slice
 * for that PR. A no-op when no window is registered (early startup / tests)
 * or when the window has been destroyed (app shutdown).
 *
 * Exported so the chokidar watcher added in a later subtask can announce
 * external writes with `reason: 'external' | 'file-deleted'`.
 */
export function emitChanged(
  projectId: string,
  prNumber: number,
  reason: ManualFindingsChangeReason,
): void {
  const mainWindow = mainWindowAccessor?.();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_CHANGED,
    projectId,
    prNumber,
    reason,
  );
}

/* -------------------------------------------------------------------------- */
/* chokidar watcher for external writes                                        */
/* -------------------------------------------------------------------------- */

/**
 * Maps `projectId` to the chokidar watcher tailing that project's
 * `.auto-claude/github/pr/manual_findings_*.json` glob. Indexed by project so
 * a closed project can release its native fs.watch handle without affecting
 * other projects' watchers.
 *
 * Lifecycle:
 *   - `startManualFindingsWatcher(project)` — lazy-start on first use
 *     (mirrors the lazy-start pattern in `project-store.ts`).
 *   - `stopManualFindingsWatcher(projectId)` — explicit per-project teardown.
 *   - `stopAllManualFindingsWatchers()` — invoked from the main process
 *     `before-quit` handler so chokidar's native watcher handles do not
 *     outlive the JS environment.
 */
const watchers = new Map<string, FSWatcher>();

/**
 * Filename pattern for the manual findings files we watch. Captures the PR
 * number out of `manual_findings_<N>.json` so an external write/delete on
 * disk can be routed to the correct renderer subscription. Files matching
 * the glob but not the regex (e.g. a stray `manual_findings_backup.json`)
 * are silently ignored — the regex is the source of truth, the glob is
 * just a cheap pre-filter.
 */
const MANUAL_FINDINGS_FILENAME_RE = /^manual_findings_(\d+)\.json$/;

/**
 * Resolve the absolute path of the PR directory for a project. This is the
 * directory holding `manual_findings_<prNumber>.json` (alongside the AI
 * review JSON files). The watcher tails this directory; the IPC handlers
 * read/write individual files via `getManualFindingsPath`.
 */
function getPRDir(project: Project): string {
  return path.join(project.path, '.auto-claude', 'github', 'pr');
}

/**
 * Start watching a project's PR directory for `manual_findings_*.json`
 * changes. Idempotent — a second call for the same project is a no-op.
 *
 * The watcher emits `GITHUB_PR_MANUAL_FINDINGS_CHANGED` with reason:
 *   - `'external'`     on `add` / `change` (covers both terminal-LLM-direct
 *                       writes and any other external editor)
 *   - `'file-deleted'` on `unlink`
 *
 * The chokidar settings mirror `file-watcher.ts:73-80` exactly so the
 * 300ms `awaitWriteFinish` window collapses `writeFileAtomicSync`'s
 * temp+rename into a single emitted event (instead of an `add` then a
 * `change` racing past each other).
 */
export function startManualFindingsWatcher(project: Project): void {
  if (watchers.has(project.id)) {
    return;
  }

  const prDir = getPRDir(project);

  // Ensure the directory exists so chokidar can immediately bind to it.
  // Without this, the watcher silently misses events until the first AI
  // review creates the directory.
  try {
    fs.mkdirSync(prDir, { recursive: true });
  } catch (error) {
    debugLog('Failed to ensure PR dir for watcher', {
      projectId: project.id,
      prDir,
      error: error instanceof Error ? error.message : error,
    });
    // Continue — chokidar gracefully tolerates a missing parent at glob
    // expansion time and will start watching once the directory appears.
  }

  try {
    const watcher = chokidar.watch(
      path.join(prDir, 'manual_findings_*.json'),
      {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
      },
    );

    /**
     * Route a chokidar filesystem event back to the renderer. Extracts the
     * PR number from the basename via `MANUAL_FINDINGS_FILENAME_RE` and
     * silently drops files whose names do not match the canonical shape.
     */
    const handleEvent = (
      filepath: string,
      reason: ManualFindingsChangeReason,
    ): void => {
      const basename = path.basename(filepath);
      const match = basename.match(MANUAL_FINDINGS_FILENAME_RE);
      if (!match) return;
      const prNumber = Number(match[1]);
      if (!Number.isFinite(prNumber) || prNumber <= 0) return;
      emitChanged(project.id, prNumber, reason);
    };

    watcher.on('add', (filepath: string) =>
      handleEvent(filepath, 'external'),
    );
    watcher.on('change', (filepath: string) =>
      handleEvent(filepath, 'external'),
    );
    watcher.on('unlink', (filepath: string) =>
      handleEvent(filepath, 'file-deleted'),
    );

    watcher.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      debugLog('Manual findings watcher error', {
        projectId: project.id,
        error: message,
      });
      safeBreadcrumb({
        category: 'manual-findings',
        level: 'warning',
        message: 'Manual findings watcher error',
        data: { projectId: project.id, error: message },
      });
    });

    watchers.set(project.id, watcher);
    debugLog('Started manual findings watcher', {
      projectId: project.id,
      prDir,
    });
  } catch (error) {
    debugLog('Failed to start manual findings watcher', {
      projectId: project.id,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Stop the watcher for a project. Safe to call when no watcher is
 * registered (e.g. a project that never opened the PR review surface).
 * Mirrors `project-store.ts:464-472` lifecycle shape.
 */
export function stopManualFindingsWatcher(projectId: string): void {
  const watcher = watchers.get(projectId);
  if (!watcher) return;
  // Delete from the map first so a concurrent start() can install a fresh
  // watcher without observing the about-to-be-closed handle.
  watchers.delete(projectId);
  watcher.close().catch((error: unknown) => {
    debugLog('Error closing manual findings watcher', {
      projectId,
      error: error instanceof Error ? error.message : error,
    });
  });
}

/**
 * Close every watcher. Call during app shutdown so chokidar's native
 * fs.watch handles do not outlive the JS environment (mirrors
 * `project-store.ts:478-485`).
 */
export async function stopAllManualFindingsWatchers(): Promise<void> {
  const allWatchers = Array.from(watchers.values());
  watchers.clear();
  await Promise.all(
    allWatchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        debugLog('Error closing manual findings watcher during shutdown', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Payload sanitization                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Filter a patch object down to only the user-mutable fields.
 *
 * `id`, `source`, `authoredAt`, `authoredBy`, and the AI-only validation*
 * fields are immutable on UPDATE — any attempt to overwrite them via the
 * patch is silently dropped so a misbehaving caller cannot rewrite the audit
 * trail.
 */
function pickPatchableFields(
  patch: Partial<PRReviewFinding>,
): Partial<PRReviewFinding> {
  const out: Partial<PRReviewFinding> = {};
  for (const field of PATCHABLE_FIELDS) {
    const value = patch[field as PatchableField];
    if (value !== undefined) {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Haiku scrollback extractor                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Model pinned for the scrollback extractor. The user's active profile may
 * point at any Sonnet/Opus/etc. — we override it explicitly here because the
 * extractor is a one-shot structured-extraction call where Haiku's latency
 * and cost profile dominate quality differences.
 *
 * If this slug ever needs to change, update the spec section 7 Path B in
 * lock-step (the spec calls out `claude-haiku-4-5` as the pinned slug).
 */
const HAIKU_EXTRACTOR_MODEL = 'claude-haiku-4-5';

/**
 * Hard ceiling on a single Anthropic request. The model rarely takes more
 * than ~5–15s for these structured extractions, but we leave headroom so a
 * transient slow path does not surface as a user-visible error. The Abort
 * signal from the UI's "Cancel" button is still respected — the timeout is
 * just the no-input upper bound.
 */
const HAIKU_EXTRACTOR_TIMEOUT_MS = 20_000;

/**
 * Maximum tokens the extractor may emit. 4096 comfortably fits ~30 findings
 * worth of JSON; we keep the cap modest so the model does not hallucinate a
 * runaway list when the transcript actually contains zero findings.
 */
const HAIKU_EXTRACTOR_MAX_TOKENS = 4096;

/**
 * Transcript size thresholds (post-ANSI-strip bytes). Transcripts ≤
 * `EXTRACTOR_SINGLE_PASS_BYTES` are sent to the model in a single request;
 * larger transcripts are split into overlapping windows of
 * `EXTRACTOR_CHUNK_BYTES`, each subsequent window starting
 * `EXTRACTOR_CHUNK_STRIDE_BYTES` later so the seams overlap by ~10%. The
 * dedup pass after extraction collapses any candidate the model surfaced in
 * two adjacent windows.
 *
 *   - 80KB single-pass    — well within Haiku's input window and lets us
 *                            keep the simple non-chunked path for the common
 *                            case (most discussion terminals).
 *   - 40KB chunk          — fits comfortably alongside the prompt scaffolding
 *                            even at 4-bytes-per-character UTF-8.
 *   - 36KB stride         — 4KB overlap = 10%, enough to catch a finding
 *                            split across the seam without spamming the
 *                            dedup pass.
 */
const EXTRACTOR_SINGLE_PASS_BYTES = 80 * 1024;
const EXTRACTOR_CHUNK_BYTES = 40 * 1024;
const EXTRACTOR_CHUNK_STRIDE_BYTES = 36 * 1024;

/**
 * Payload accepted by the extractor IPC handler. Only `terminalId` and
 * `prNumber` are required from the renderer — everything else (PR context,
 * model, signal) is resolved server-side.
 */
export interface ExtractFindingsRequest {
  terminalId: string;
  prNumber: number;
}

/**
 * Resolve the currently active **API** profile.
 *
 * Returns `null` when:
 *   - no profile is active (fresh install / OAuth-only setup),
 *   - the active profile id does not match any persisted profile,
 *   - the active profile is missing its `apiKey` (OAuth fallback case).
 *
 * The extractor needs both `apiKey` and `baseUrl`, so OAuth-only setups
 * cannot drive it — the caller should surface a "configure an API profile"
 * hint in that case rather than silently returning empty results.
 */
async function getActiveAPIProfile(): Promise<APIProfile | null> {
  try {
    const profilesFile = await loadProfilesFile();
    if (!profilesFile.activeProfileId) return null;
    const profile = profilesFile.profiles.find(
      (p) => p.id === profilesFile.activeProfileId,
    );
    if (!profile || !profile.apiKey || !profile.baseUrl) return null;
    return profile;
  } catch (error) {
    debugLog('Failed to load API profiles for extractor', {
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

/**
 * Construct the prompt sent to the Haiku model.
 *
 * The prompt is deterministic and structured: it states the task, lists the
 * exact JSON schema each candidate must match, and embeds the transcript in
 * a fenced block. We instruct the model to emit ONLY a JSON array (no
 * commentary, no markdown wrappers) — and still strip ``` fences from the
 * response defensively because models occasionally ignore that instruction.
 *
 * Including the PR number and chunk metadata in the prompt is purely
 * cosmetic provenance — it lets the model anchor relative file references
 * to the right PR and hints at which slice of a long transcript it is
 * looking at when chunking is active.
 */
function buildExtractorPrompt(
  transcript: string,
  prNumber: number,
  chunkInfo?: { index: number; total: number },
): string {
  const chunkHeader = chunkInfo
    ? `\n\nThis is chunk ${chunkInfo.index + 1} of ${chunkInfo.total} from a longer transcript; findings that span chunk boundaries may appear partial — extract them anyway and rely on the post-processing dedup pass.`
    : '';

  return [
    `You are extracting structured code-review findings from a developer's terminal transcript that discusses PR #${prNumber}.${chunkHeader}`,
    '',
    'Read the transcript and identify any concrete code issues that were called out — bugs, security flaws, performance problems, missing tests, style/pattern violations, or documentation gaps. Skip conversational remarks, planning chatter, and findings that were explicitly retracted or dismissed.',
    '',
    'Return ONLY a JSON array (no markdown fences, no prose). Each element must match this exact schema:',
    '',
    '```json',
    '{',
    '  "severity": "critical" | "high" | "medium" | "low",',
    '  "category": "security" | "quality" | "style" | "test" | "docs" | "pattern" | "performance",',
    '  "title": "short headline (max 200 chars)",',
    '  "description": "detailed explanation; include the relevant source quote from the transcript for provenance",',
    '  "file": "repo-relative file path, or empty string if unknown",',
    '  "line": 0,                  // first line of the issue; 0 if not pinpointed',
    '  "endLine": 0,               // optional last line; omit if single-line',
    '  "suggestedFix": "optional code or prose fix",',
    '  "fixable": false            // true when the suggestion is mechanically applicable',
    '}',
    '```',
    '',
    'Rules:',
    '- If you cannot identify any concrete finding, return `[]`.',
    '- Do not invent file paths or line numbers — leave `file` empty and `line` at 0 when uncertain.',
    '- Prefer fewer, higher-confidence findings over speculative ones.',
    '- Each `description` MUST include at least one short verbatim quote from the transcript so the reviewer can verify provenance.',
    '',
    '----- BEGIN TRANSCRIPT -----',
    transcript,
    '----- END TRANSCRIPT -----',
  ].join('\n');
}

/**
 * Strip a leading/trailing ``` fence from the model response, if present.
 *
 * Handles all three forms the model occasionally emits despite the "no
 * fences" instruction:
 *   - ```json\n[...]\n```
 *   - ```\n[...]\n```
 *   - [...]   (no fence — passthrough)
 */
function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json|JSON)?\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();
}

/**
 * Split a long transcript into overlapping windows for chunked extraction.
 *
 * The simple "non-overlapping slice" strategy would lose findings that
 * straddle the seam — the 10% overlap (4KB out of every 40KB) gives the
 * model the surrounding context it needs to recognize a finding even when
 * the previous chunk truncated its source quote. The post-extraction dedup
 * pass collapses anything the model surfaced in both overlapping windows.
 */
function chunkTranscript(transcript: string): string[] {
  if (transcript.length <= EXTRACTOR_SINGLE_PASS_BYTES) {
    return [transcript];
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < transcript.length) {
    const slice = transcript.slice(offset, offset + EXTRACTOR_CHUNK_BYTES);
    chunks.push(slice);
    if (offset + EXTRACTOR_CHUNK_BYTES >= transcript.length) {
      break;
    }
    offset += EXTRACTOR_CHUNK_STRIDE_BYTES;
  }
  return chunks;
}

/**
 * Send one extractor request to Haiku and return the parsed/validated
 * candidate findings.
 *
 * Each candidate is:
 *   1. Pre-stamped with a fresh server-side id and `source: 'terminal'` and
 *      `authoredBy: 'terminal-extraction'` so the renderer can immediately
 *      route it through the same `…_ADD` path as in-app authoring.
 *   2. Run through `PRReviewFindingSchema.safeParse` so a malformed
 *      candidate (missing field, wrong enum value, etc.) is dropped without
 *      poisoning the rest of the batch.
 *
 * `fixable` defaults to `false` when the model omits it because the schema
 * requires it; every other optional field is left untouched.
 */
async function runOneExtractorPass(
  client: Anthropic,
  transcript: string,
  prNumber: number,
  chunkInfo: { index: number; total: number } | undefined,
  signal: AbortSignal | undefined,
): Promise<PRReviewFinding[]> {
  const prompt = buildExtractorPrompt(transcript, prNumber, chunkInfo);

  const response = await client.messages.create(
    {
      model: HAIKU_EXTRACTOR_MODEL,
      max_tokens: HAIKU_EXTRACTOR_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    },
    { signal: signal ?? undefined },
  );

  const textBlock = response.content.find((block) => block.type === 'text');
  const rawText = textBlock && 'text' in textBlock ? textBlock.text : '';
  if (!rawText.trim()) {
    return [];
  }

  const cleaned = stripCodeFences(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    debugLog('Extractor returned non-JSON output', {
      prNumber,
      error: error instanceof Error ? error.message : error,
      preview: cleaned.slice(0, 200),
    });
    safeBreadcrumb({
      category: 'manual-findings',
      level: 'warning',
      message: 'Extractor returned non-JSON',
      data: { prNumber, preview: cleaned.slice(0, 200) },
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    debugLog('Extractor output was not a JSON array', { prNumber });
    return [];
  }

  const findings: PRReviewFinding[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object') continue;
    const enriched = {
      // Defensive defaults — schema requires these even if model omits.
      fixable: false,
      ...(candidate as Record<string, unknown>),
      // Server-stamped fields override anything the model may have invented.
      id: makeId(),
      source: 'terminal' as const,
      authoredAt: new Date().toISOString(),
      authoredBy: 'terminal-extraction',
    };
    const result = PRReviewFindingSchema.safeParse(enriched);
    if (result.success) {
      findings.push(result.data as PRReviewFinding);
    } else {
      debugLog('Skipped malformed extractor candidate', {
        prNumber,
        error: result.error.message,
      });
    }
  }
  return findings;
}

/**
 * Dedupe candidates by (file, line, title). Adjacent overlapping chunks may
 * surface the same finding twice — the dedup pass keeps the first occurrence
 * so the order from earlier chunks (closer to the start of the transcript)
 * wins. Using `title` in the key (rather than `description`) is intentional:
 * the model often generates slightly different descriptions for the same
 * underlying issue when the source quote straddles the chunk seam.
 */
function dedupeFindings(findings: PRReviewFinding[]): PRReviewFinding[] {
  const seen = new Set<string>();
  const out: PRReviewFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.file}|${finding.line}|${finding.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

/**
 * Extract candidate manual findings from a PR-discussion terminal's
 * scrollback buffer using a Haiku-tier Anthropic call.
 *
 * High-level flow:
 *   1. Resolve the terminal's last-100KB output buffer (pty-manager caps it).
 *   2. Strip ANSI escapes so the model sees plain text.
 *   3. If the cleaned transcript is empty, return `[]` (no error — the user
 *      may have hit "Capture" on a fresh terminal).
 *   4. Resolve the active API profile so we have an `apiKey` + `baseUrl`.
 *   5. Single-pass when the transcript fits in `EXTRACTOR_SINGLE_PASS_BYTES`;
 *      otherwise chunk into overlapping windows and dedup the union.
 *   6. Return validated candidates to the renderer for confirmation.
 *
 * The function never throws on a model / parse / validation error — those
 * are logged + breadcrumbed and the bad candidate is dropped. Network /
 * auth / signal-abort errors propagate so the renderer can surface a toast
 * with the reason and a retry affordance.
 */
export async function extractFindingsFromTranscript(
  terminalId: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<PRReviewFinding[]> {
  if (!terminalOutputBufferAccessor) {
    debugLog('Extractor invoked but terminal accessor not registered', {
      terminalId,
      prNumber,
    });
    return [];
  }

  const rawBuffer = terminalOutputBufferAccessor(terminalId);
  if (!rawBuffer) {
    debugLog('Extractor invoked but terminal has no output buffer', {
      terminalId,
      prNumber,
    });
    return [];
  }

  const transcript = stripAnsiCodes(rawBuffer).trim();
  if (!transcript) {
    return [];
  }

  const profile = await getActiveAPIProfile();
  if (!profile) {
    throw new Error(
      'No active API profile with apiKey/baseUrl. Configure an API profile to enable scrollback extraction.',
    );
  }

  const client = new Anthropic({
    apiKey: profile.apiKey,
    baseURL: profile.baseUrl,
    timeout: HAIKU_EXTRACTOR_TIMEOUT_MS,
    maxRetries: 0,
  });

  const chunks = chunkTranscript(transcript);
  const allFindings: PRReviewFinding[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) {
      debugLog('Extractor aborted via signal', {
        terminalId,
        prNumber,
        chunkIndex: i,
        totalChunks: chunks.length,
      });
      break;
    }
    const chunkInfo =
      chunks.length > 1 ? { index: i, total: chunks.length } : undefined;
    try {
      const findings = await runOneExtractorPass(
        client,
        chunks[i],
        prNumber,
        chunkInfo,
        signal,
      );
      allFindings.push(...findings);
    } catch (error) {
      // A single chunk failing should not nuke the whole batch — log and
      // continue. The renderer will still see candidates from the chunks
      // that succeeded.
      debugLog('Extractor chunk failed', {
        terminalId,
        prNumber,
        chunkIndex: i,
        error: error instanceof Error ? error.message : error,
      });
      safeBreadcrumb({
        category: 'manual-findings',
        level: 'warning',
        message: 'Extractor chunk failed',
        data: {
          prNumber,
          chunkIndex: i,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return dedupeFindings(allFindings);
}

/* -------------------------------------------------------------------------- */
/* Handler registration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Register the five PR-manual-findings IPC handlers. Should be called once
 * at main-process startup (alongside the other `register*Handlers` calls in
 * `ipc-handlers/github/index.ts`).
 *
 * @param getMainWindow Accessor for the active `BrowserWindow` — stashed so
 *   `emitChanged` (and the chokidar watcher) can reach the renderer without
 *   needing the window passed through every call.
 * @param getTerminalOutputBuffer Optional accessor for a terminal's last-
 *   100KB output buffer. When omitted, the EXTRACT handler is still
 *   registered but will return `[]` for every call (used by tests and any
 *   bootstrap path that does not need the scrollback extractor).
 */
export function registerPRManualFindingsHandlers(
  getMainWindow: () => BrowserWindow | null,
  getTerminalOutputBuffer?: (terminalId: string) => string | null,
): void {
  debugLog('Registering PR manual findings handlers');
  mainWindowAccessor = getMainWindow;
  terminalOutputBufferAccessor = getTerminalOutputBuffer ?? null;

  // ───────────────────────────────────────────────────────────────────────────
  // LIST — return all manual findings for a PR.
  //
  // No lock: `writeFileAtomicSync` guarantees a reader never observes a
  // partially-written file, and a slightly-stale snapshot is acceptable
  // (the renderer subscribes to CHANGED events for freshness).
  // ───────────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_LIST,
    async (_, projectId: string, prNumber: number): Promise<PRReviewFinding[]> => {
      debugLog('list handler called', { projectId, prNumber });
      const result = await withProjectOrNull(projectId, async (project) => {
        // Lazy-start the chokidar watcher on first access for this project,
        // mirroring `project-store.ts:316` (lazy specs watcher start on
        // first cache miss). `startManualFindingsWatcher` is idempotent —
        // repeated LIST calls do not pile up duplicate watchers.
        startManualFindingsWatcher(project);
        const file = loadManualFindings(project, prNumber);
        return file.findings;
      });
      return result ?? [];
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // ADD — append a new manual finding.
  //
  // Server-generated fields (`id`, `authoredAt`) overwrite any caller-supplied
  // values; `source` defaults to `'manual'` when not provided so the
  // "+ Add Finding" dialog can omit it. The fully-constructed finding is
  // validated through `PRReviewFindingSchema` before persistence so malformed
  // payloads (missing required fields, wrong enum values) are rejected at the
  // IPC boundary rather than corrupting the on-disk file.
  //
  // Returns the persisted finding so the renderer can immediately update its
  // store without a follow-up LIST roundtrip.
  // ───────────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_ADD,
    async (
      _,
      projectId: string,
      prNumber: number,
      payload: Partial<PRReviewFinding>,
    ): Promise<PRReviewFinding | null> => {
      debugLog('add handler called', { projectId, prNumber });
      return withProjectOrNull(projectId, async (project) => {
        return withLock(`${projectId}:${prNumber}`, async () => {
          const file = loadManualFindings(project, prNumber);

          // Assemble candidate finding. `pickPatchableFields` drops anything
          // the renderer should not be authoring directly (id, authoredAt,
          // etc.) before the server-generated values are layered on top.
          const candidate = {
            ...pickPatchableFields(payload),
            id: makeId(),
            source: payload.source ?? 'manual',
            authoredAt: new Date().toISOString(),
            // `authoredBy` is optional — undefined is fine and gets stripped
            // by JSON.stringify on persistence.
            authoredBy: payload.authoredBy,
            // `fixable` is required by the schema; default to false when the
            // caller leaves it out (e.g. the minimum 5-field dialog).
            fixable: payload.fixable ?? false,
          } as PRReviewFinding;

          const parsed = PRReviewFindingSchema.safeParse(candidate);
          if (!parsed.success) {
            debugLog('Rejected invalid manual finding ADD payload', {
              prNumber,
              error: parsed.error.message,
            });
            throw new Error(
              `Invalid manual finding payload: ${parsed.error.message}`,
            );
          }

          const finding = parsed.data as PRReviewFinding;
          file.findings.push(finding);
          saveManualFindings(project, prNumber, file);
          emitChanged(projectId, prNumber, 'add');
          return finding;
        });
      });
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // UPDATE — patch mutable fields on an existing finding.
  //
  // Immutable fields (`id`, `source`, `authoredAt`, `authoredBy`) and the
  // AI-only validation* fields are silently stripped from the patch via
  // `pickPatchableFields`. The merged finding is re-validated against the
  // schema so a partial patch that happens to break the shape (e.g. a
  // misspelled severity) is rejected with a clear error.
  //
  // Returns `null` when no finding with the given id exists (so the renderer
  // can show a "no longer exists" toast); returns the updated finding on
  // success so the renderer can sync its local store in one roundtrip.
  // ───────────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_UPDATE,
    async (
      _,
      projectId: string,
      prNumber: number,
      id: string,
      patch: Partial<PRReviewFinding>,
    ): Promise<PRReviewFinding | null> => {
      debugLog('update handler called', { projectId, prNumber, id });
      return withProjectOrNull(projectId, async (project) => {
        return withLock(`${projectId}:${prNumber}`, async () => {
          const file = loadManualFindings(project, prNumber);
          const idx = file.findings.findIndex((f) => f.id === id);
          if (idx === -1) {
            debugLog('update target not found', { prNumber, id });
            return null;
          }

          const merged: PRReviewFinding = {
            ...file.findings[idx],
            ...pickPatchableFields(patch),
          };

          const parsed = PRReviewFindingSchema.safeParse(merged);
          if (!parsed.success) {
            debugLog('Rejected invalid manual finding UPDATE patch', {
              prNumber,
              id,
              error: parsed.error.message,
            });
            throw new Error(
              `Invalid manual finding patch: ${parsed.error.message}`,
            );
          }

          const updated = parsed.data as PRReviewFinding;
          file.findings[idx] = updated;
          saveManualFindings(project, prNumber, file);
          emitChanged(projectId, prNumber, 'update');
          return updated;
        });
      });
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // DELETE — remove a finding by id.
  //
  // Returns `true` when a finding was removed, `false` when no finding with
  // the given id existed (so the renderer can decide whether to show a
  // "nothing to delete" toast or just no-op).
  // ───────────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_DELETE,
    async (
      _,
      projectId: string,
      prNumber: number,
      id: string,
    ): Promise<boolean> => {
      debugLog('delete handler called', { projectId, prNumber, id });
      const result = await withProjectOrNull(projectId, async (project) => {
        return withLock(`${projectId}:${prNumber}`, async () => {
          const file = loadManualFindings(project, prNumber);
          const before = file.findings.length;
          file.findings = file.findings.filter((f) => f.id !== id);
          if (file.findings.length === before) {
            debugLog('delete target not found', { prNumber, id });
            return false;
          }
          saveManualFindings(project, prNumber, file);
          emitChanged(projectId, prNumber, 'delete');
          return true;
        });
      });
      return result ?? false;
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // EXTRACT — run the Haiku scrollback extractor over a terminal's last-100KB
  // output buffer and return validated candidate findings for confirmation.
  //
  // This handler is intentionally read-only: it returns candidates without
  // persisting them. The renderer shows `ExtractFindingsConfirmDialog`, the
  // user ticks the candidates they want, and each checked candidate goes
  // through the regular `…_ADD` path (which is what writes them to disk and
  // emits the CHANGED event). That keeps the audit trail consistent — every
  // persisted finding goes through the same single ADD code path regardless
  // of authoring surface.
  //
  // Errors propagate to the renderer so the UI can surface a toast with the
  // reason (network, auth, no active API profile, abort). Returning `[]` is
  // the "no candidates" outcome — not the "something broke" outcome.
  // ───────────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_MANUAL_FINDINGS_EXTRACT,
    async (
      _,
      terminalId: string,
      prNumber: number,
    ): Promise<PRReviewFinding[]> => {
      debugLog('extract handler called', { terminalId, prNumber });
      return extractFindingsFromTranscript(terminalId, prNumber);
    },
  );
}
