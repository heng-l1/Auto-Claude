/**
 * PR Review Comments Store
 *
 * Manages per-PR review thread state, AI-generated reply suggestions,
 * draft persistence, and thread operations (reply, resolve/unresolve).
 * State is keyed by `${projectId}:${prNumber}` for multi-PR support.
 */

import { create } from 'zustand';
import type {
  ReviewThread,
  PRReviewThreadsResult,
  SuggestedReply,
  ReplyDraft,
  ThreadState,
  SuggestedReplyStatus,
  ReplyClassification
} from '../../../shared/types/pr-review-comments';

/**
 * Per-PR thread state
 */
interface PRThreadState {
  /** Fetched review threads result */
  threads: PRReviewThreadsResult | null;
  /** Whether threads are currently being fetched */
  loading: boolean;
  /** Error message from the last failed operation */
  error: string | null;
  /** AI-generated reply suggestions keyed by thread ID */
  suggestedReplies: Record<string, SuggestedReply>;
  /** Whether AI reply generation is in progress */
  generatingReplies: boolean;
  /** Linked fix task IDs keyed by thread ID */
  fixTaskIds: Record<string, string>;
  /** Saved reply drafts keyed by thread ID (auto-saved to disk) */
  drafts: Record<string, ReplyDraft>;
}

interface PRReviewCommentsStoreState {
  /** State keyed by `${projectId}:${prNumber}` */
  prThreads: Record<string, PRThreadState>;

  // Data fetching
  /** Fetch review threads for a PR via IPC */
  fetchThreads: (projectId: string, prNumber: number) => Promise<void>;

  // AI reply generation (streaming)
  /** Trigger AI reply generation for unresolved threads */
  generateReplies: (projectId: string, prNumber: number) => void;
  /** Cancel ongoing AI reply generation */
  cancelGeneration: (projectId: string, prNumber: number) => void;

  // Reply management
  /** Update a suggested reply's content and set status to 'editing' */
  updateSuggestedReply: (projectId: string, prNumber: number, threadId: string, content: string) => void;
  /** Post a reply to a thread via IPC and update local state */
  postReply: (projectId: string, prNumber: number, threadId: string, body: string) => Promise<void>;

  // Thread operations
  /** Resolve or unresolve a thread via IPC and update local state */
  resolveThread: (projectId: string, prNumber: number, threadId: string, resolved: boolean) => Promise<void>;
  /** Link a fix task to a thread */
  setFixTask: (projectId: string, prNumber: number, threadId: string, taskId: string) => void;

  // Draft persistence (debounced auto-save)
  /** Save current drafts to disk via IPC */
  saveDrafts: (projectId: string, prNumber: number) => Promise<void>;
  /** Load drafts from disk via IPC and merge with thread data */
  loadDrafts: (projectId: string, prNumber: number) => Promise<void>;

  // Selectors
  /** Compute the display state of a thread based on resolution, fix tasks, and last comment */
  getThreadState: (thread: ReviewThread, prAuthorLogin: string, fixTaskIds: Record<string, string>) => ThreadState;
  /** Get the per-PR thread state for a project+PR combination */
  getPRThreadState: (projectId: string, prNumber: number) => PRThreadState | null;
}

/**
 * Create a default PRThreadState for initialization
 */
function createDefaultThreadState(): PRThreadState {
  return {
    threads: null,
    loading: false,
    error: null,
    suggestedReplies: {},
    generatingReplies: false,
    fixTaskIds: {},
    drafts: {},
  };
}

/**
 * Build the composite key for a project+PR combination
 */
function getKey(projectId: string, prNumber: number): string {
  return `${projectId}:${prNumber}`;
}

// Debounce timers for draft auto-save, keyed by composite key
const saveDraftTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const SAVE_DRAFT_DEBOUNCE_MS = 2000;

export const usePRReviewCommentsStore = create<PRReviewCommentsStoreState>((set, get) => ({
  // Initial state
  prThreads: {},

  fetchThreads: async (projectId: string, prNumber: number) => {
    const key = getKey(projectId, prNumber);

    // Set loading state
    set((state) => ({
      prThreads: {
        ...state.prThreads,
        [key]: {
          ...(state.prThreads[key] ?? createDefaultThreadState()),
          loading: true,
          error: null,
        },
      },
    }));

    try {
      const result = await window.electronAPI.github.getReviewThreads(projectId, prNumber);
      set((state) => ({
        prThreads: {
          ...state.prThreads,
          [key]: {
            ...(state.prThreads[key] ?? createDefaultThreadState()),
            threads: result,
            loading: false,
            error: null,
          },
        },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch review threads';
      set((state) => ({
        prThreads: {
          ...state.prThreads,
          [key]: {
            ...(state.prThreads[key] ?? createDefaultThreadState()),
            loading: false,
            error: message,
          },
        },
      }));
    }
  },

  generateReplies: (projectId: string, prNumber: number) => {
    const key = getKey(projectId, prNumber);

    // Mark all unresolved threads as 'generating'
    set((state) => {
      const existing = state.prThreads[key] ?? createDefaultThreadState();
      const updatedReplies = { ...existing.suggestedReplies };

      if (existing.threads) {
        for (const thread of existing.threads.threads) {
          if (!thread.isResolved) {
            updatedReplies[thread.id] = {
              content: '',
              status: 'generating',
            };
          }
        }
      }

      return {
        prThreads: {
          ...state.prThreads,
          [key]: {
            ...existing,
            generatingReplies: true,
            suggestedReplies: updatedReplies,
            error: null,
          },
        },
      };
    });

    // Serialize unresolved threads to pass to the backend runner
    const currentState = get().prThreads[key];
    const unresolvedThreads = (currentState?.threads?.threads ?? [])
      .filter(t => !t.isResolved)
      .map(t => ({
        id: t.id,
        path: t.path,
        line: t.line,
        diffHunk: t.diffHunk,
        comments: t.comments.map(c => ({
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
        })),
      }));
    const threadsJson = JSON.stringify(unresolvedThreads);

    // Fire-and-forget IPC call to trigger backend reply generation
    window.electronAPI.github.suggestReplies(projectId, prNumber, threadsJson);
  },

  cancelGeneration: (projectId: string, prNumber: number) => {
    const key = getKey(projectId, prNumber);

    // Mark any 'generating' replies as 'ready' with whatever content they have
    set((state) => {
      const existing = state.prThreads[key];
      if (!existing) return state;

      const updatedReplies = { ...existing.suggestedReplies };
      for (const [threadId, reply] of Object.entries(updatedReplies)) {
        if (reply.status === 'generating') {
          updatedReplies[threadId] = {
            ...reply,
            status: reply.content.trim() ? 'ready' : 'error',
            ...(reply.content.trim() ? {} : { error: 'Generation cancelled' }),
          };
        }
      }

      return {
        prThreads: {
          ...state.prThreads,
          [key]: {
            ...existing,
            generatingReplies: false,
            suggestedReplies: updatedReplies,
          },
        },
      };
    });

    // Fire-and-forget IPC call to cancel backend process
    window.electronAPI.github.cancelSuggestReplies(projectId, prNumber);
  },

  updateSuggestedReply: (projectId: string, prNumber: number, threadId: string, content: string) => {
    const key = getKey(projectId, prNumber);

    set((state) => {
      const existing = state.prThreads[key];
      if (!existing) return state;

      const currentReply = existing.suggestedReplies[threadId];

      return {
        prThreads: {
          ...state.prThreads,
          [key]: {
            ...existing,
            suggestedReplies: {
              ...existing.suggestedReplies,
              [threadId]: {
                ...(currentReply ?? { content: '', status: 'editing' as SuggestedReplyStatus }),
                content,
                status: 'editing',
              },
            },
            // Also update the draft for persistence
            drafts: {
              ...existing.drafts,
              [threadId]: {
                threadId,
                content,
                updatedAt: new Date().toISOString(),
              },
            },
          },
        },
      };
    });

    // Trigger debounced auto-save
    if (saveDraftTimers[key]) {
      clearTimeout(saveDraftTimers[key]);
    }
    saveDraftTimers[key] = setTimeout(() => {
      get().saveDrafts(projectId, prNumber).catch(() => {
        // Silently fail — drafts are non-critical
      });
    }, SAVE_DRAFT_DEBOUNCE_MS);
  },

  postReply: async (projectId: string, prNumber: number, threadId: string, body: string) => {
    const key = getKey(projectId, prNumber);

    try {
      const newComment = await window.electronAPI.github.replyToThread(projectId, threadId, body);

      set((state) => {
        const existing = state.prThreads[key];
        if (!existing || !existing.threads) return state;

        // Append the new comment to the matching thread
        const updatedThreads = existing.threads.threads.map((thread) => {
          if (thread.id === threadId) {
            return {
              ...thread,
              comments: [...thread.comments, newComment],
            };
          }
          return thread;
        });

        // Update suggested reply status to 'posted'
        const updatedReplies = { ...existing.suggestedReplies };
        if (updatedReplies[threadId]) {
          updatedReplies[threadId] = {
            ...updatedReplies[threadId],
            status: 'posted',
          };
        }

        // Remove the draft since reply was posted
        const { [threadId]: _removedDraft, ...remainingDrafts } = existing.drafts;

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              threads: {
                ...existing.threads,
                threads: updatedThreads,
              },
              suggestedReplies: updatedReplies,
              drafts: remainingDrafts,
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post reply';
      set((state) => {
        const existing = state.prThreads[key];
        if (!existing) return state;

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              error: message,
            },
          },
        };
      });
      throw err;
    }
  },

  resolveThread: async (projectId: string, prNumber: number, threadId: string, resolved: boolean) => {
    const key = getKey(projectId, prNumber);

    try {
      const updatedThread = await window.electronAPI.github.resolveThread(projectId, threadId, resolved);

      set((state) => {
        const existing = state.prThreads[key];
        if (!existing || !existing.threads) return state;

        // Update the thread's isResolved state from the mutation response
        const updatedThreads = existing.threads.threads.map((thread) => {
          if (thread.id === threadId) {
            return {
              ...thread,
              isResolved: updatedThread.isResolved,
              resolvedBy: updatedThread.resolvedBy,
            };
          }
          return thread;
        });

        // Recompute unresolvedCount
        const unresolvedCount = updatedThreads.filter((t) => !t.isResolved).length;

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              threads: {
                ...existing.threads,
                threads: updatedThreads,
                unresolvedCount,
              },
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update thread resolution';
      set((state) => {
        const existing = state.prThreads[key];
        if (!existing) return state;

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              error: message,
            },
          },
        };
      });
      throw err;
    }
  },

  setFixTask: (projectId: string, prNumber: number, threadId: string, taskId: string) => {
    const key = getKey(projectId, prNumber);

    set((state) => {
      const existing = state.prThreads[key];
      if (!existing) return state;

      return {
        prThreads: {
          ...state.prThreads,
          [key]: {
            ...existing,
            fixTaskIds: {
              ...existing.fixTaskIds,
              [threadId]: taskId,
            },
          },
        },
      };
    });
  },

  saveDrafts: async (projectId: string, prNumber: number) => {
    const key = getKey(projectId, prNumber);
    const existing = get().prThreads[key];
    if (!existing || Object.keys(existing.drafts).length === 0) return;

    try {
      await window.electronAPI.github.saveReplyDrafts(projectId, prNumber, existing.drafts);
    } catch {
      // Silently fail — draft persistence is non-critical
    }
  },

  loadDrafts: async (projectId: string, prNumber: number) => {
    const key = getKey(projectId, prNumber);

    try {
      const drafts = await window.electronAPI.github.loadReplyDrafts(projectId, prNumber);

      set((state) => {
        const existing = state.prThreads[key] ?? createDefaultThreadState();

        // Merge loaded drafts with existing thread data, filtering out drafts
        // for threads that no longer exist or are already resolved
        const threadIds = new Set(
          existing.threads?.threads.map((t) => t.id) ?? []
        );
        const validDrafts: Record<string, ReplyDraft> = {};
        for (const [threadId, draft] of Object.entries(drafts)) {
          if (threadIds.size === 0 || threadIds.has(threadId)) {
            validDrafts[threadId] = draft;
          }
        }

        // Also populate suggested replies from loaded drafts (status: 'editing')
        const updatedReplies = { ...existing.suggestedReplies };
        for (const [threadId, draft] of Object.entries(validDrafts)) {
          if (!updatedReplies[threadId] || updatedReplies[threadId].status !== 'posted') {
            updatedReplies[threadId] = {
              content: draft.content,
              status: 'editing',
            };
          }
        }

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              drafts: { ...existing.drafts, ...validDrafts },
              suggestedReplies: updatedReplies,
            },
          },
        };
      });
    } catch {
      // Silently fail — draft loading is non-critical
    }
  },

  // Selectors

  getThreadState: (thread: ReviewThread, prAuthorLogin: string, fixTaskIds: Record<string, string>): ThreadState => {
    if (thread.isResolved) {
      return 'resolved';
    }

    if (fixTaskIds[thread.id]) {
      return 'addressed';
    }

    // Check if the last comment is from the PR author
    const lastComment = thread.comments[thread.comments.length - 1];
    if (lastComment?.isAuthor) {
      return 'responded';
    }

    return 'new';
  },

  getPRThreadState: (projectId: string, prNumber: number): PRThreadState | null => {
    const { prThreads } = get();
    const key = getKey(projectId, prNumber);
    return prThreads[key] ?? null;
  },
}));

/**
 * Global IPC listener setup for PR review comment streaming events.
 * Call this once at app startup to ensure streaming events are captured
 * regardless of which component is mounted.
 */
let listenersInitialized = false;
let cleanupFunctions: (() => void)[] = [];

export function initializePRReviewCommentsListeners(): void {
  if (listenersInitialized) {
    return;
  }

  // Check if the streaming API is available
  if (!window.electronAPI?.github?.onSuggestRepliesChunk) {
    return;
  }

  // Listen for per-thread reply chunks during AI generation
  const cleanupChunk = window.electronAPI.github.onSuggestRepliesChunk(
    (projectId: string, prNumber: number, chunk: { threadId: string; content: string; status: SuggestedReplyStatus; classification?: ReplyClassification }) => {
      const key = getKey(projectId, prNumber);

      usePRReviewCommentsStore.setState((state) => {
        const existing = state.prThreads[key];
        if (!existing) return state;

        const currentReply = existing.suggestedReplies[chunk.threadId];
        // For 'generating' status, append content; for 'ready', replace
        const newContent = chunk.status === 'generating'
          ? (currentReply?.content ?? '') + chunk.content
          : chunk.content;

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              suggestedReplies: {
                ...existing.suggestedReplies,
                [chunk.threadId]: {
                  content: newContent,
                  status: chunk.status,
                  classification: chunk.classification ?? currentReply?.classification,
                },
              },
            },
          },
        };
      });
    }
  );
  cleanupFunctions.push(cleanupChunk);

  // Listen for generation completion
  const cleanupComplete = window.electronAPI.github.onSuggestRepliesComplete(
    (projectId: string, prNumber: number) => {
      const key = getKey(projectId, prNumber);

      usePRReviewCommentsStore.setState((state) => {
        const existing = state.prThreads[key];
        if (!existing) return state;

        // Finalize any still-generating replies to 'ready'
        const updatedReplies = { ...existing.suggestedReplies };
        for (const [threadId, reply] of Object.entries(updatedReplies)) {
          if (reply.status === 'generating') {
            updatedReplies[threadId] = {
              ...reply,
              status: reply.content.trim() ? 'ready' : 'error',
              ...(reply.content.trim() ? {} : { error: 'No reply generated' }),
            };
          }
        }

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              generatingReplies: false,
              suggestedReplies: updatedReplies,
            },
          },
        };
      });
    }
  );
  cleanupFunctions.push(cleanupComplete);

  // Listen for generation errors
  const cleanupError = window.electronAPI.github.onSuggestRepliesError(
    (projectId: string, prNumber: number, error: string) => {
      const key = getKey(projectId, prNumber);

      usePRReviewCommentsStore.setState((state) => {
        const existing = state.prThreads[key];
        if (!existing) return state;

        // Mark any 'generating' replies as 'error'
        const updatedReplies = { ...existing.suggestedReplies };
        for (const [threadId, reply] of Object.entries(updatedReplies)) {
          if (reply.status === 'generating') {
            updatedReplies[threadId] = {
              ...reply,
              status: reply.content.trim() ? 'ready' : 'error',
              error,
            };
          }
        }

        return {
          prThreads: {
            ...state.prThreads,
            [key]: {
              ...existing,
              generatingReplies: false,
              error,
              suggestedReplies: updatedReplies,
            },
          },
        };
      });
    }
  );
  cleanupFunctions.push(cleanupError);

  listenersInitialized = true;
}

/**
 * Cleanup PR review comment listeners.
 * Call this during app unmount or hot-reload.
 */
export function cleanupPRReviewCommentsListeners(): void {
  for (const cleanup of cleanupFunctions) {
    try {
      cleanup();
    } catch {
      // Ignore cleanup errors
    }
  }
  cleanupFunctions = [];

  // Clear any pending save timers
  for (const timer of Object.values(saveDraftTimers)) {
    clearTimeout(timer);
  }
  for (const key of Object.keys(saveDraftTimers)) {
    delete saveDraftTimers[key];
  }

  listenersInitialized = false;
}
