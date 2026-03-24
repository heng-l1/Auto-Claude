/**
 * PR Discussion Store
 *
 * Lightweight chat state for interactive PR review discussions.
 * Each PR gets its own conversation that persists during the session.
 * Assistant messages can be posted as GitHub PR comments.
 */

import { create } from 'zustand';

export interface PRDiscussionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /** Whether this message has been posted as a PR comment */
  postedAsComment?: boolean;
}

interface PRDiscussionSession {
  prNumber: number;
  messages: PRDiscussionMessage[];
}

type DiscussionPhase = 'idle' | 'thinking' | 'streaming' | 'error';

interface PRDiscussionState {
  /** Active discussions keyed by `${projectId}:${prNumber}` */
  sessions: Record<string, PRDiscussionSession>;
  /** Streaming content for the active response */
  streamingContent: string;
  /** Which PR is currently streaming */
  streamingKey: string | null;
  /** Current phase */
  phase: DiscussionPhase;
  /** Error message if any */
  error: string | null;

  // Actions
  addUserMessage: (key: string, prNumber: number, content: string) => void;
  appendStreamingContent: (content: string) => void;
  finalizeAssistantMessage: (key: string) => void;
  setPhase: (phase: DiscussionPhase, streamingKey?: string | null) => void;
  setError: (error: string | null) => void;
  markPosted: (key: string, messageId: string) => void;
  clearSession: (key: string) => void;
}

export const usePRDiscussionStore = create<PRDiscussionState>((set, get) => ({
  sessions: {},
  streamingContent: '',
  streamingKey: null,
  phase: 'idle',
  error: null,

  addUserMessage: (key, prNumber, content) => {
    set(state => {
      const session = state.sessions[key] || { prNumber, messages: [] };
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...session,
            messages: [
              ...session.messages,
              {
                id: `msg-${Date.now()}`,
                role: 'user' as const,
                content,
                timestamp: new Date(),
              },
            ],
          },
        },
      };
    });
  },

  appendStreamingContent: (content) => {
    set(state => ({
      streamingContent: state.streamingContent + content,
    }));
  },

  finalizeAssistantMessage: (key) => {
    const { streamingContent, sessions } = get();
    if (!streamingContent.trim()) {
      set({ streamingContent: '', streamingKey: null, phase: 'idle' });
      return;
    }

    const session = sessions[key];
    if (!session) {
      set({ streamingContent: '', streamingKey: null, phase: 'idle' });
      return;
    }

    set({
      sessions: {
        ...sessions,
        [key]: {
          ...session,
          messages: [
            ...session.messages,
            {
              id: `msg-${Date.now()}`,
              role: 'assistant' as const,
              content: streamingContent.trim(),
              timestamp: new Date(),
            },
          ],
        },
      },
      streamingContent: '',
      streamingKey: null,
      phase: 'idle',
    });
  },

  setPhase: (phase, streamingKey) => {
    set({
      phase,
      ...(streamingKey !== undefined ? { streamingKey } : {}),
      ...(phase !== 'error' ? { error: null } : {}),
      ...(phase === 'thinking' ? { streamingContent: '' } : {}),
    });
  },

  setError: (error) => {
    set({ error, phase: 'error', streamingKey: null });
  },

  markPosted: (key, messageId) => {
    set(state => {
      const session = state.sessions[key];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...session,
            messages: session.messages.map(m =>
              m.id === messageId ? { ...m, postedAsComment: true } : m
            ),
          },
        },
      };
    });
  },

  clearSession: (key) => {
    set(state => {
      const { [key]: _, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },
}));

/**
 * Get the discussion key for a project+PR combination
 */
export function getDiscussionKey(projectId: string, prNumber: number): string {
  return `${projectId}:${prNumber}`;
}
