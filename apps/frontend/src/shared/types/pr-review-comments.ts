/**
 * PR Review Comment Response Types
 *
 * Types for the PR review comment response feature that fetches review
 * comment threads on user-authored PRs, generates AI reply drafts,
 * and supports posting replies and resolving threads.
 * Used across IPC boundary (main process, preload, renderer).
 */

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
