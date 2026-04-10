/**
 * GitHub PR Review IPC handlers
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis
 * 3. Post review comments
 * 4. Apply fixes
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import {
  IPC_CHANNELS,
  MODEL_ID_MAP,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_THINKING,
} from "../../../shared/constants";
import type { AuthFailureInfo } from "../../../shared/types/terminal";
import { getGitHubConfig, githubFetch, normalizeRepoReference } from "./utils";
import { readSettingsFile } from "../../settings-utils";
import { getAugmentedEnv } from "../../env-utils";
import { getMemoryService, getDefaultDbPath } from "../../memory-service";
import type { Project, AppSettings } from "../../../shared/types";
import { createContextLogger } from "./utils/logger";
import { withProjectOrNull } from "./utils/project-middleware";
import { createIPCCommunicators } from "./utils/ipc-communicator";
import { getRunnerEnv } from "./utils/runner-env";
import {
  runPythonSubprocess,
  getPythonPath,
  getRunnerPath,
  getBackendPath,
  validateGitHubModule,
  buildRunnerArgs,
} from "./utils/subprocess-runner";
import type {
  ReviewThread,
  ReviewThreadComment,
  PRReviewThreadsResult,
  ReplyDraft,
  ReplyDraftsFile,
} from "../../../shared/types/pr-review-comments";
import { getPRStatusPoller } from "../../services/pr-status-poller";
import { PRReviewStateManager } from "../../pr-review-state-manager";
import { notificationService } from "../../notification-service";
import { safeBreadcrumb, safeCaptureException } from "../../sentry";
import { sanitizeForSentry } from "../../../shared/utils/sentry-privacy";
import type {
  StartPollingRequest,
  StopPollingRequest,
  PollingMetadata,
} from "../../../shared/types/pr-status";

/**
 * GraphQL response type for PR list query
 * Note: repository can be null if the repo doesn't exist or user lacks access
 */
interface GraphQLPRNode {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  assignees: { nodes: Array<{ login: string }> };
  createdAt: string;
  updatedAt: string;
  url: string;
  isDraft: boolean;
}

interface GraphQLPRListResponse {
  data: {
    repository: {
      pullRequests: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: GraphQLPRNode[];
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Maps a GraphQL PR node to the frontend PRData format.
 * Shared between listPRs and listMorePRs handlers.
 */
function mapGraphQLPRToData(pr: GraphQLPRNode): PRData {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state.toLowerCase(),
    author: { login: pr.author?.login ?? "unknown" },
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    assignees: pr.assignees.nodes.map((a) => ({ login: a.login })),
    files: [],
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    htmlUrl: pr.url,
    isDraft: pr.isDraft,
  };
}

/**
 * Make a GraphQL request to GitHub API
 */
async function githubGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  // lgtm[js/file-access-to-http] - Official GitHub GraphQL API endpoint
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Auto-Claude-UI",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    // Log detailed error for debugging, throw generic message for safety
    console.error(`GitHub GraphQL HTTP error: ${response.status} ${response.statusText}`);
    throw new Error("Failed to connect to GitHub API");
  }

  const result = await response.json() as T & { errors?: Array<{ message: string }> };

  // Check for GraphQL-level errors
  if (result.errors && result.errors.length > 0) {
    // Log detailed errors for debugging, throw generic message for safety
    console.error(`GitHub GraphQL errors: ${result.errors.map(e => e.message).join(", ")}`);
    throw new Error("GitHub API request failed");
  }

  return result;
}

/**
 * GraphQL query to fetch PRs with diff stats
 */
const LIST_PRS_QUERY = `
query($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        state
        author { login }
        headRefName
        baseRefName
        additions
        deletions
        changedFiles
        assignees(first: 10) { nodes { login } }
        createdAt
        updatedAt
        url
        isDraft
      }
    }
  }
}
`;

/**
 * GraphQL query to fetch review comment threads for a PR
 */
const GET_REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      author { login }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          subjectType
          viewerCanReply
          viewerCanResolve
          viewerCanUnresolve
          resolvedBy { login }
          comments(first: 50) {
            nodes {
              id
              databaseId
              author { login avatarUrl }
              body
              createdAt
              updatedAt
              diffHunk
            }
          }
        }
      }
    }
  }
}
`;

/**
 * GraphQL mutation to reply to a review thread
 * Uses addPullRequestReviewThreadReply (NOT deprecated addPullRequestReviewComment)
 */
const REPLY_TO_THREAD_MUTATION = `
mutation AddPullRequestReviewThreadReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId
    body: $body
  }) {
    comment {
      id
      databaseId
      author { login avatarUrl }
      body
      createdAt
      updatedAt
    }
  }
}
`;

/**
 * GraphQL mutation to resolve a review thread
 * Uses threadId parameter (NOT pullRequestReviewThreadId)
 */
const RESOLVE_THREAD_MUTATION = `
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved resolvedBy { login } }
  }
}
`;

/**
 * GraphQL mutation to unresolve a review thread
 */
const UNRESOLVE_THREAD_MUTATION = `
mutation UnresolveReviewThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}
`;

/**
 * GraphQL response types for review thread operations
 */
interface GraphQLReviewThreadCommentNode {
  id: string;
  databaseId: number;
  author: { login: string; avatarUrl: string } | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  diffHunk: string | null;
}

interface GraphQLReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  diffSide: "LEFT" | "RIGHT" | null;
  subjectType: "LINE" | "FILE" | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: { login: string } | null;
  comments: {
    nodes: GraphQLReviewThreadCommentNode[];
  };
}

interface GraphQLReviewThreadsResponse {
  data: {
    repository: {
      pullRequest: {
        author: { login: string } | null;
        reviewThreads: {
          totalCount: number;
          nodes: GraphQLReviewThreadNode[];
        };
      } | null;
    } | null;
  };
}

interface GraphQLReplyToThreadResponse {
  data: {
    addPullRequestReviewThreadReply: {
      comment: GraphQLReviewThreadCommentNode;
    };
  };
}

interface GraphQLResolveThreadResponse {
  data: {
    resolveReviewThread: {
      thread: { id: string; isResolved: boolean; resolvedBy: { login: string } | null };
    };
  };
}

interface GraphQLUnresolveThreadResponse {
  data: {
    unresolveReviewThread: {
      thread: { id: string; isResolved: boolean };
    };
  };
}

/**
 * Sanitize network data before writing to file
 * Removes potentially dangerous characters and limits length
 */
function sanitizeNetworkData(data: string, maxLength = 1000000): string {
  // Remove null bytes and other control characters except newlines/tabs/carriage returns
  // Using code points instead of escape sequences to avoid no-control-regex ESLint rule
  const controlCharsPattern = new RegExp(
    "[" +
      String.fromCharCode(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08) + // \x00-\x08
      String.fromCharCode(0x0b, 0x0c) + // \x0B, \x0C (skip \x0A which is newline)
      String.fromCharCode(
        0x0e,
        0x0f,
        0x10,
        0x11,
        0x12,
        0x13,
        0x14,
        0x15,
        0x16,
        0x17,
        0x18,
        0x19,
        0x1a,
        0x1b,
        0x1c,
        0x1d,
        0x1e,
        0x1f
      ) + // \x0E-\x1F
      String.fromCharCode(0x7f) + // \x7F (DEL)
      "]",
    "g"
  );
  let sanitized = data.replace(controlCharsPattern, "");

  // Limit length to prevent DoS
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}

// Debug logging
const { debug: debugLog } = createContextLogger("GitHub PR");

/**
 * Parse a GitHub API patch string into a set of valid new-file line numbers.
 *
 * Walks @@ hunk headers and counts + (additions) and space-prefixed (context)
 * lines to determine which new-file line numbers are commentable via the
 * GitHub review API. Deletion lines (- prefix) are excluded.
 *
 * @param patch - Raw patch string from GitHub API file object
 * @returns Set of valid new-file line numbers
 */
export function parsePatchForNewFileLines(patch: string | null | undefined): Set<number> {
  const validLines = new Set<number>();

  if (!patch) {
    return validLines;
  }

  const lines = patch.split("\n");
  let newLineNumber = 0;

  for (const line of lines) {
    // Parse @@ hunk header to get new-file start line
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNumber = Number.parseInt(hunkMatch[1], 10);
      continue;
    }

    if (newLineNumber === 0) {
      // Haven't seen a hunk header yet, skip
      continue;
    }

    // Skip "\ No newline at end of file" marker
    if (line.startsWith("\\")) {
      continue;
    }

    if (line.startsWith("+")) {
      // Addition line — valid commentable new-file line
      validLines.add(newLineNumber);
      newLineNumber++;
    } else if (line.startsWith("-")) {
      // Deletion line — not a new-file line, don't increment new line counter
    } else {
      // Context line (space prefix) — valid commentable new-file line
      validLines.add(newLineNumber);
      newLineNumber++;
    }
  }

  return validLines;
}

/**
 * Review comment produced by buildReviewComments().
 * Includes optional subject_type for file-level comments.
 */
export interface ReviewComment {
  path: string;
  line?: number;
  body: string;
  subject_type?: "line" | "file";
}

/**
 * Result of buildReviewComments(): inline comments for the GitHub review
 * comments array, and file-level entries formatted as markdown for the review body.
 */
export interface BuildReviewCommentsResult {
  inlineComments: ReviewComment[];
  fileLevelEntries: string[];
}

/**
 * Build review comments with diff-aware routing:
 * - Inline (line-level) for findings on lines within the diff → inlineComments
 * - File-level for findings on lines outside the diff but in a PR file → fileLevelEntries
 * - Skipped for findings on files not in the PR
 *
 * @param findings - Array of PR review findings to route
 * @param fileLineMap - Map of filename → valid line numbers in the diff, or null to fall back to all-inline
 * @returns Object with inlineComments for the review comments array and fileLevelEntries for the review body
 */
export function buildReviewComments(
  findings: PRReviewFinding[],
  fileLineMap: Map<string, Set<number>> | null,
): BuildReviewCommentsResult {
  const inlineComments: ReviewComment[] = [];
  const fileLevelEntries: string[] = [];
  for (const f of findings) {
    if (f.file && f.line && f.line > 0) {
      const emoji =
        { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" }[f.severity] || "⚪";
      let commentBody = `${emoji} **[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.description}`;
      const suggestedFix = f.suggestedFix?.trim();
      if (suggestedFix) {
        commentBody += `\n\n**Suggested fix:**\n\`\`\`\n${suggestedFix}\n\`\`\``;
      }

      // Normalize path by stripping leading './' to match GitHub's repo-relative paths
      const normalizedPath = f.file.replace(/^\.\//, "");

      if (fileLineMap) {
        // Diff-aware routing: validate line against the PR diff
        const validLines = fileLineMap.get(normalizedPath);
        if (validLines) {
          if (validLines.has(f.line)) {
            // Line is in the diff — post as inline line-level comment
            inlineComments.push({ path: normalizedPath, line: f.line, body: commentBody });
          } else {
            // Line is NOT in the diff — add as formatted markdown for the review body
            fileLevelEntries.push(`- **${normalizedPath}** (line ${f.line}): ${commentBody}`);
          }
        }
        // If file not in map, skip this finding (file not in PR)
      } else {
        // fileLineMap is null (fetch failed) — fall back to original behavior
        inlineComments.push({ path: normalizedPath, line: f.line, body: commentBody });
      }
    }
  }
  return { inlineComments, fileLevelEntries };
}

/**
 * Sentinel value indicating a review is waiting for CI checks to complete.
 * Used as a placeholder in runningReviews before the actual process is spawned.
 */
const CI_WAIT_PLACEHOLDER = Symbol("CI_WAIT_PLACEHOLDER");
type CIWaitPlaceholder = typeof CI_WAIT_PLACEHOLDER;

/**
 * Registry of running PR review processes
 * Key format: `${projectId}:${prNumber}`
 * Value can be:
 * - ChildProcess: actual running review process
 * - CI_WAIT_PLACEHOLDER: review is waiting for CI checks to complete
 */
const runningReviews = new Map<string, import("child_process").ChildProcess | CIWaitPlaceholder>();

/**
 * Registry of running PR conflict resolution processes
 * Key format: `${projectId}:resolve:${prNumber}`
 */
const runningConflictResolutions = new Map<string, import("child_process").ChildProcess>();

/**
 * Registry of abort controllers for CI wait cancellation
 * Key format: `${projectId}:${prNumber}`
 */
const ciWaitAbortControllers = new Map<string, AbortController>();

/**
 * XState-backed state manager that emits unified GITHUB_PR_REVIEW_STATE_CHANGE
 * events to the renderer (replaces legacy progress/complete/error channels).
 */
let prReviewStateManager: PRReviewStateManager | null = null;

/**
 * Get the registry key for a PR review
 */
export function getReviewKey(projectId: string, prNumber: number): string {
  return `${projectId}:${prNumber}`;
}

/**
 * Check if a review is currently running for a given project and PR number
 */
export function isReviewRunning(projectId: string, prNumber: number): boolean {
  return runningReviews.has(getReviewKey(projectId, prNumber));
}

/**
 * Returns env vars for Claude.md usage; enabled unless explicitly opted out.
 */
function getClaudeMdEnv(project: Project): Record<string, string> | undefined {
  return project.settings?.useClaudeMd !== false ? { USE_CLAUDE_MD: "true" } : undefined;
}

/**
 * PR review finding from AI analysis
 */
export interface PRReviewFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "quality" | "style" | "test" | "docs" | "pattern" | "performance";
  title: string;
  description: string;
  file: string;
  line: number;
  endLine?: number;
  suggestedFix?: string;
  fixable: boolean;
  validationStatus?: "confirmed_valid" | "dismissed_false_positive" | "needs_human_review" | null;
  validationExplanation?: string;
  sourceAgents?: string[];
  crossValidated?: boolean;
}

/**
 * Complete PR review result
 */
export interface PRReviewResult {
  prNumber: number;
  repo: string;
  success: boolean;
  findings: PRReviewFinding[];
  summary: string;
  overallStatus: "approve" | "request_changes" | "comment" | "in_progress";
  reviewId?: number;
  reviewedAt: string;
  error?: string;
  // Follow-up review fields
  reviewedCommitSha?: string;
  reviewedFileBlobs?: Record<string, string>; // filename → blob SHA for rebase-resistant follow-ups
  isFollowupReview?: boolean;
  previousReviewId?: number;
  resolvedFindings?: string[];
  unresolvedFindings?: string[];
  newFindingsSinceLastReview?: string[];
  // Track if findings have been posted to GitHub (enables follow-up review)
  hasPostedFindings?: boolean;
  postedFindingIds?: string[];
  postedAt?: string;
  // In-progress review tracking
  inProgressSince?: string;
  // AI-generated change summary
  changeSummary?: string;
  verdict?: string;
  verdictReasoning?: string;
}

/**
 * Result of checking for new commits since last review
 */
export interface NewCommitsCheck {
  hasNewCommits: boolean;
  newCommitCount: number;
  lastReviewedCommit?: string;
  currentHeadCommit?: string;
  /** Whether new commits happened AFTER findings were posted (for "Ready for Follow-up" status) */
  hasCommitsAfterPosting?: boolean;
  /** Whether new commits touch files that had findings (requires verification) */
  hasOverlapWithFindings?: boolean;
  /** Files from new commits that overlap with finding files */
  overlappingFiles?: string[];
  /** Whether this appears to be a merge from base branch (develop/main) */
  isMergeFromBase?: boolean;
}

/**
 * Lightweight merge readiness check result
 * Used for real-time validation of AI verdict freshness
 */
export interface MergeReadiness {
  /** PR is in draft mode */
  isDraft: boolean;
  /** GitHub's mergeable status */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Branch is behind base branch (out of date) */
  isBehind: boolean;
  /** Simplified CI status */
  ciStatus: "passing" | "failing" | "pending" | "none";
  /** List of blockers that contradict a "ready to merge" verdict */
  blockers: string[];
}

/**
 * PR review memory stored in the memory layer
 * Represents key information about a review for follow-ups
 */
export interface PRReviewMemory {
  projectId: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  /** Commit SHA when review was conducted */
  reviewedCommitSha: string;
  /** Timestamp when findings were posted to GitHub */
  postedAt: string;
  /** IDs of findings that were posted (enables follow-up matching) */
  postedFindingIds: string[];
  /** Last commit that was analyzed (for new commits check) */
  lastAnalyzedCommitSha: string;
  /** Map of file path → blob SHA for rebase-resistant follow-ups */
  fileBlobs: Record<string, string>;
  /** Count of findings at last review (for progress tracking) */
  findingsSummary: {
    total: number;
    bySeverity: { critical: number; high: number; medium: number; low: number };
  };
  /** Verdict from last review */
  lastVerdict?: "approve" | "request_changes" | "comment";
  /** Summary from last review */
  lastSummary?: string;
}

/**
 * Type of data to fetch for a PR diff
 */
export type PRDiffType = "files" | "threads";

/**
 * Stores currently fetched PR diff data
 * Reset when PR or review context changes
 */
const prDiffCache = new Map<
  string,
  {
    type: PRDiffType;
    data: PRFile[] | ReviewThread[];
    timestamp: number;
  }
>();

// IPC handler registration and management functions would continue here...