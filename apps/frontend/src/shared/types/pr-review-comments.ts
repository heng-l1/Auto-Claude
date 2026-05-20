/**
 * PR Review Comment Response Types
 *
 * Types for the PR review comment response feature that fetches review
 * comment threads on user-authored PRs, generates AI reply drafts,
 * and supports posting replies and resolving threads.
 * Used across IPC boundary (main process, preload, renderer).
 */

import { z } from 'zod';

/**
 * A single comment within a review thread
 */
export interface ReviewThreadComment {
  /** GraphQL node ID */
  id: string;
  /** REST numeric ID (for GitHub URLs) */
  databaseId: number;
  /** Comment author — null for ghost/deleted users */
  author: { login: string; avatarUrl?: string } | null;
  /** Comment body (Markdown) */
  body: string;
  /** ISO timestamp when comment was created */
  createdAt: string;
  /** ISO timestamp when comment was last updated */
  updatedAt: string;
  /** Diff hunk context — only present on first comment in thread */
  diffHunk?: string;
  /** Whether comment author is the PR author */
  isAuthor: boolean;
}

/**
 * Diff side indicator for review threads
 * - LEFT: Comment on the old/removed side of the diff
 * - RIGHT: Comment on the new/added side of the diff
 */
export type DiffSide = 'LEFT' | 'RIGHT';

/**
 * Subject type for review threads
 * - LINE: Comment on a specific line of code
 * - FILE: Comment on the file as a whole (no specific line)
 */
export type SubjectType = 'LINE' | 'FILE';

/**
 * A review comment thread on a pull request
 */
export interface ReviewThread {
  /** GraphQL node ID (used for reply/resolve mutations) */
  id: string;
  /** Whether the thread has been resolved */
  isResolved: boolean;
  /** Whether the thread is outdated (code has changed since comment) */
  isOutdated: boolean;
  /** File path the thread is on (undefined for PR-level comments) */
  path?: string;
  /** Line number (undefined for file-level comments where subjectType is FILE) */
  line?: number;
  /** Which side of the diff the comment is on */
  diffSide?: DiffSide;
  /** Whether this is a line-level or file-level comment */
  subjectType?: SubjectType;
  /** Diff hunk context — sourced from comments.nodes[0].diffHunk */
  diffHunk?: string;
  /** Whether the current viewer can reply to this thread */
  viewerCanReply: boolean;
  /** Whether the current viewer can resolve this thread */
  viewerCanResolve: boolean;
  /** Whether the current viewer can unresolve this thread */
  viewerCanUnresolve: boolean;
  /** User who resolved the thread — null for bot accounts, undefined if unresolved */
  resolvedBy?: { login: string } | null;
  /** Comments in this thread, ordered chronologically */
  comments: ReviewThreadComment[];
}

/**
 * Computed thread state — derived at runtime, not stored
 * - new: Last comment is not from the PR author (needs response)
 * - responded: Last comment is from the PR author
 * - addressed: A fix task has been linked to this thread
 * - resolved: Thread has been marked as resolved
 */
export type ThreadState = 'new' | 'responded' | 'addressed' | 'resolved';

/**
 * Result of fetching review threads for a PR
 */
export interface PRReviewThreadsResult {
  /** All review threads on the PR */
  threads: ReviewThread[];
  /** Total number of review threads */
  totalCount: number;
  /** Number of unresolved threads */
  unresolvedCount: number;
  /** ISO timestamp when threads were fetched */
  fetchedAt: string;
}

/**
 * AI-generated reply suggestion status
 * - generating: AI is currently generating the reply
 * - ready: Reply is generated and ready for review
 * - posted: Reply has been posted to GitHub
 * - editing: User is editing the suggested reply
 * - error: Reply generation failed
 */
export type SuggestedReplyStatus = 'generating' | 'ready' | 'posted' | 'editing' | 'error';

/**
 * AI-generated reply suggestion classification
 * - reply_only: Thread can be addressed with a reply
 * - needs_fix: Thread requires code changes to address
 */
export type ReplyClassification = 'reply_only' | 'needs_fix';

/**
 * AI-generated reply suggestion for a review thread
 */
export interface SuggestedReply {
  /** Suggested reply content (Markdown) */
  content: string;
  /** Current status of the suggestion */
  status: SuggestedReplyStatus;
  /** Whether the thread needs a code fix or just a reply */
  classification?: ReplyClassification;
  /** Error message if generation failed */
  error?: string;
}

/**
 * A saved draft reply for a review thread
 */
export interface ReplyDraft {
  /** GraphQL node ID of the thread this draft is for */
  threadId: string;
  /** Draft reply content (Markdown) */
  content: string;
  /** ISO timestamp when the draft was last updated */
  updatedAt: string;
}

/**
 * Persisted reply drafts file — saved to disk for app restart survival
 * Stored at: .auto-claude/github/pr/reply_drafts_{prNumber}.json
 */
export interface ReplyDraftsFile {
  /** PR number these drafts belong to */
  prNumber: number;
  /** Draft replies keyed by thread GraphQL node ID */
  drafts: Record<string, ReplyDraft>;
  /** ISO timestamp when drafts were last saved */
  savedAt: string;
}

// ============================================================================
// PR Review Findings
// ============================================================================
// Canonical home for `PRReviewFinding`. Previously this interface was
// duplicated in both `main/ipc-handlers/github/pr-handlers.ts` and
// `preload/api/modules/github-api.ts`; both modules now re-export from here
// to keep a single source of truth across the IPC boundary.

/**
 * A finding produced by a PR review pass — by the AI reviewer, by Claude
 * running in a discussion terminal, or by the human via the "+ Add Finding"
 * dialog. All three sources share the same shape; the optional `source`
 * discriminator tells callers how the finding was produced.
 *
 * Fields are kept back-compat with the previous duplicate declarations:
 *   - Pre-existing fields (id, severity, ..., crossValidated) are preserved
 *     unchanged; the optional `validation*`, `sourceAgents`, `crossValidated`
 *     fields stay optional so older serialized findings keep parsing.
 *   - Three new optional fields support manual finding authoring:
 *       `source`     — who produced the finding ('ai' | 'terminal' | 'manual')
 *       `authoredAt` — ISO 8601 timestamp when the finding was authored
 *       `authoredBy` — opaque author identifier (user name, 'terminal-extraction', ...)
 */
export interface PRReviewFinding {
  /** Stable identifier — `manual-<iso>-<6char>` for manual/terminal sources */
  id: string;
  /** Severity ranking — drives the verdict and the emoji prefix */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Finding category */
  category: 'security' | 'quality' | 'style' | 'test' | 'docs' | 'pattern' | 'performance';
  /** One-line headline shown in the findings list */
  title: string;
  /** Detailed description (Markdown) posted as the comment body */
  description: string;
  /** File path relative to repo root — empty/unknown allowed for file-level notes */
  file: string;
  /** First line of the finding's range (0 means "no specific line") */
  line: number;
  /** Last line of the range — when set and `> line`, posts as multi-line range */
  endLine?: number;
  /** Optional suggested fix snippet (Markdown / code fence) */
  suggestedFix?: string;
  /** Whether the finding has an automatable fix */
  fixable: boolean;
  /** Cross-validation outcome from the AI reviewer pipeline */
  validationStatus?: 'confirmed_valid' | 'dismissed_false_positive' | 'needs_human_review' | null;
  /** Free-form explanation accompanying `validationStatus` */
  validationExplanation?: string;
  /** Agents that surfaced this finding (cross-validation provenance) */
  sourceAgents?: string[];
  /** Whether the finding was confirmed by more than one agent */
  crossValidated?: boolean;
  /** Who produced the finding — default `'ai'` when omitted (back-compat) */
  source?: 'ai' | 'terminal' | 'manual';
  /** ISO 8601 timestamp when the finding was authored */
  authoredAt?: string;
  /** Opaque author identifier (e.g. user name, 'terminal-extraction') */
  authoredBy?: string;
}

/**
 * Semantic alias for findings authored by a human or by Claude in a
 * discussion terminal — i.e. `source !== 'ai'`. The shape is identical to
 * `PRReviewFinding`; the alias exists to make call sites self-documenting
 * where the intent is "this is a manually authored finding".
 */
export type ManualPRReviewFinding = PRReviewFinding;

// ============================================================================
// Zod Schemas + Safe Loaders (manual findings persistence)
// ============================================================================
// These schemas validate manual finding payloads at IPC boundaries and when
// rehydrating .auto-claude/github/pr/manual_findings_<prNumber>.json files
// from disk. The shape mirrors the `PRReviewFinding` interface above one-for-
// one (including the back-compat optional `validation*`, `sourceAgents`,
// `crossValidated` fields and the new `source`/`authoredAt`/`authoredBy`
// authorship fields). Pattern follows apps/frontend/src/main/agent/
// phase-event-schema.ts.

/**
 * Zod schema mirroring the `PRReviewFinding` interface. Use this with
 * `safeParse` to validate one finding at a time; mass-parsing through this
 * schema's `parse` will throw on the first bad entry, which is not what
 * `loadManualFindingsSafe` wants (we skip-and-log per entry).
 *
 * Note: every optional field on the interface is `.optional()` here so older
 * serialized findings (pre-`source`/`authoredAt`/`authoredBy`) still parse.
 */
export const PRReviewFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.enum([
    'security',
    'quality',
    'style',
    'test',
    'docs',
    'pattern',
    'performance',
  ]),
  title: z.string(),
  description: z.string(),
  file: z.string(),
  line: z.number().int(),
  endLine: z.number().int().optional(),
  suggestedFix: z.string().optional(),
  fixable: z.boolean(),
  // Preserved cross-validation provenance fields (optional for back-compat)
  validationStatus: z
    .enum([
      'confirmed_valid',
      'dismissed_false_positive',
      'needs_human_review',
    ])
    .nullable()
    .optional(),
  validationExplanation: z.string().optional(),
  sourceAgents: z.array(z.string()).optional(),
  crossValidated: z.boolean().optional(),
  // New manual-authoring fields (optional — `'ai'` is the implied default)
  source: z.enum(['ai', 'terminal', 'manual']).optional(),
  authoredAt: z.string().optional(),
  authoredBy: z.string().optional(),
});

/**
 * Zod schema for the persisted `manual_findings_<prNumber>.json` file. The
 * file stores the PR number + repo slug + ISO timestamp of the last write +
 * the array of findings (each validated against `PRReviewFindingSchema`).
 */
export const ManualFindingsFileSchema = z.object({
  prNumber: z.number().int().positive(),
  repo: z.string(),
  updatedAt: z.iso.datetime(),
  findings: z.array(PRReviewFindingSchema),
});

/**
 * Type-inferred view of a validated manual findings file.
 */
export type ManualFindingsFile = z.infer<typeof ManualFindingsFileSchema>;

/**
 * Best-effort Sentry breadcrumb emitter for shared (process-agnostic) code.
 *
 * `pr-review-comments.ts` lives under `apps/frontend/src/shared/` and is
 * imported by BOTH the Electron main bundle and the renderer bundle. We
 * therefore cannot import `@sentry/electron/main` or `@sentry/electron/
 * renderer` directly here — each is process-specific and would break the
 * other bundle. Instead we reach into `globalThis.__SENTRY__.hub`, which
 * Sentry v7 (the version pinned in package.json) populates after `init()`
 * runs in whichever process is hosting us. If Sentry is not initialised
 * (tests, forks without DSN, very early startup) the call no-ops silently.
 *
 * Mirrors the intent of `safeBreadcrumb` in `apps/frontend/src/main/
 * sentry.ts:187` but without the process coupling.
 */
function emitSentryBreadcrumb(breadcrumb: SentryBreadcrumb): void {
  try {
    const sentryGlobal = (
      globalThis as {
        __SENTRY__?: {
          hub?: { addBreadcrumb?: (b: SentryBreadcrumb) => void };
        };
      }
    ).__SENTRY__;
    sentryGlobal?.hub?.addBreadcrumb?.(breadcrumb);
  } catch {
    /* Sentry not initialized — swallow */
  }
}

/**
 * Validate a manual findings payload safely.
 *
 * - Returns `[]` for missing, null, non-object, or non-shaped input — this is
 *   intentional: a freshly-created PR has no findings file yet, and we don't
 *   want callers to have to special-case "file not found / file empty".
 * - Uses **per-entry `safeParse`** so a single malformed finding (e.g. an
 *   older record missing a now-required field, a corrupted JSON line) does
 *   not nuke the whole list. Invalid entries record a Sentry breadcrumb
 *   under category `manual-findings` and are silently skipped.
 * - Valid entries are returned in their original order.
 *
 * @param raw - The decoded JSON value (or anything). Typically the result of
 *              `JSON.parse(readFileSync(...))`.
 * @returns Validated `PRReviewFinding[]`. Never throws.
 */
export function loadManualFindingsSafe(raw: unknown): PRReviewFinding[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const file = raw as { findings?: unknown };
  if (!Array.isArray(file.findings)) {
    return [];
  }

  const findings: PRReviewFinding[] = [];
  for (const entry of file.findings) {
    const parsed = PRReviewFindingSchema.safeParse(entry);
    if (!parsed.success) {
      emitSentryBreadcrumb({
        category: 'manual-findings',
        level: 'warning',
        message: 'Skipped invalid entry',
        data: { error: parsed.error.message },
      });
      continue;
    }
    findings.push(parsed.data as PRReviewFinding);
  }
  return findings;
}
