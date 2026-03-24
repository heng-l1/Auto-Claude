import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Loader2, Copy, Check, MessageCircle } from 'lucide-react';
import { Button } from '../../ui/button';
import { Textarea } from '../../ui/textarea';
import { cn } from '../../../lib/utils';
import { usePRDiscussionStore, getDiscussionKey } from '../../../stores/github/pr-discussion-store';
import type { PRReviewResult } from '../hooks/useGitHubPRs';

interface PRDiscussionPanelProps {
  projectId: string;
  prNumber: number;
  prTitle: string;
  reviewResult: PRReviewResult;
  onPostComment: (body: string) => Promise<boolean>;
}

function buildSystemContext(prNumber: number, prTitle: string, result: PRReviewResult): string {
  const findingsSummary = result.findings
    .map(f => `- [${f.severity.toUpperCase()}] ${f.file}:${f.line} - ${f.title}: ${f.description.substring(0, 300)}`)
    .join('\n');

  return [
    `PR #${prNumber}: "${prTitle}"`,
    `Review Status: ${result.overallStatus}`,
    '',
    '## Summary',
    result.summary,
    '',
    `## Findings (${result.findings.length})`,
    findingsSummary || 'No findings',
    '',
    '## Instructions',
    'You have access to Read, Glob, and Grep tools to explore the local codebase.',
    'Use these tools to read the actual source files when discussing findings.',
    'Do NOT attempt to run gh, git, or any shell commands — they are not available.',
    'Focus on analyzing the code and providing actionable feedback based on the review findings above.',
  ].join('\n');
}

export function PRDiscussionPanel({
  projectId,
  prNumber,
  prTitle,
  reviewResult,
  onPostComment,
}: PRDiscussionPanelProps) {
  const { t } = useTranslation('common');
  const [input, setInput] = useState('');
  const [postingId, setPostingId] = useState<string | null>(null);
  const [postedId, setPostedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const key = getDiscussionKey(projectId, prNumber);
  const session = usePRDiscussionStore(s => s.sessions[key]);
  const messages = session?.messages ?? [];
  const phase = usePRDiscussionStore(s => s.phase);
  const streamingKey = usePRDiscussionStore(s => s.streamingKey);
  const streamingContent = usePRDiscussionStore(s => s.streamingContent);
  const error = usePRDiscussionStore(s => s.error);
  const isStreaming = streamingKey === key && (phase === 'thinking' || phase === 'streaming');

  const { addUserMessage, appendStreamingContent, finalizeAssistantMessage, setPhase, setError, markPosted } =
    usePRDiscussionStore.getState();

  // Set up IPC listeners
  useEffect(() => {
    const cleanupChunk = window.electronAPI.github.onPRDiscussionChunk(
      (pid: string, pNum: number, chunk: { type: string; content?: string }) => {
        if (pid !== projectId || pNum !== prNumber) return;
        if (chunk.type === 'text' && chunk.content) {
          if (usePRDiscussionStore.getState().phase === 'thinking') {
            setPhase('streaming', key);
          }
          appendStreamingContent(chunk.content);
        } else if (chunk.type === 'done') {
          finalizeAssistantMessage(key);
        }
      }
    );

    const cleanupError = window.electronAPI.github.onPRDiscussionError(
      (pid: string, pNum: number, errMsg: string) => {
        if (pid !== projectId || pNum !== prNumber) return;
        setError(errMsg);
      }
    );

    return () => {
      cleanupChunk();
      cleanupError();
    };
  }, [projectId, prNumber, key, appendStreamingContent, finalizeAssistantMessage, setPhase, setError]);

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streamingContent]);

  const handleSend = useCallback(() => {
    const msg = input.trim();
    if (!msg || isStreaming) return;

    addUserMessage(key, prNumber, msg);
    setInput('');
    setPhase('thinking', key);

    const systemContext = buildSystemContext(prNumber, prTitle, reviewResult);
    window.electronAPI.github.sendPRDiscussionMessage(projectId, prNumber, msg, systemContext);
  }, [input, isStreaming, key, prNumber, prTitle, reviewResult, projectId, addUserMessage, setPhase]);

  const handlePostAsComment = useCallback(async (messageId: string, content: string) => {
    setPostingId(messageId);
    try {
      const success = await onPostComment(content);
      if (success) {
        markPosted(key, messageId);
        setPostedId(messageId);
        setTimeout(() => setPostedId(null), 3000);
      }
    } finally {
      setPostingId(null);
    }
  }, [key, onPostComment, markPosted]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col border border-border rounded-lg overflow-hidden bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30">
        <MessageCircle className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('prReview.discussion')}</span>
        <span className="text-xs text-muted-foreground">
          {t('prReview.discussionDescription')}
        </span>
      </div>

      {/* Messages */}
      <div className="overflow-y-auto max-h-[400px]" ref={scrollRef}>
        <div className="p-4 space-y-4">
          {messages.length === 0 && !isStreaming && (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('prReview.discussionEmpty')}
            </p>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'text-sm',
                msg.role === 'user' ? 'ml-8' : 'mr-4'
              )}
            >
              <div
                className={cn(
                  'rounded-lg px-3 py-2',
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground ml-auto max-w-[85%]'
                    : 'bg-muted max-w-full'
                )}
              >
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              </div>

              {/* Post as Comment button for assistant messages */}
              {msg.role === 'assistant' && (
                <div className="mt-1 flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-muted-foreground hover:text-foreground"
                    disabled={postingId === msg.id || msg.postedAsComment}
                    onClick={() => handlePostAsComment(msg.id, msg.content)}
                  >
                    {postingId === msg.id ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : msg.postedAsComment || postedId === msg.id ? (
                      <Check className="h-3 w-3 mr-1 text-emerald-500" />
                    ) : (
                      <Copy className="h-3 w-3 mr-1" />
                    )}
                    {msg.postedAsComment || postedId === msg.id
                      ? t('prReview.postedAsComment')
                      : t('prReview.postAsComment')}
                  </Button>
                </div>
              )}
            </div>
          ))}

          {/* Streaming response */}
          {isStreaming && (
            <div className="mr-4">
              <div className="rounded-lg px-3 py-2 bg-muted max-w-full text-sm">
                {phase === 'thinking' ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>{t('prReview.discussionThinking')}</span>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap break-words">{streamingContent}</div>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {error && streamingKey === key && (
            <div className="text-sm text-destructive px-3 py-2 bg-destructive/10 rounded-lg">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border p-3">
        <div className="flex gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('prReview.discussionPlaceholder')}
            className="min-h-[40px] max-h-[120px] resize-none text-sm"
            rows={1}
            disabled={isStreaming}
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="shrink-0 h-10 w-10"
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
