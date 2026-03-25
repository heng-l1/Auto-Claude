import { useCallback, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../../ui/button';
import type { ReviewComment } from '../../../../shared/types';

interface DiffCommentThreadProps {
  /** Existing comments to display */
  comments: ReviewComment[];
  /** Whether the add-comment form is visible */
  isAdding: boolean;
  /** Called when the user submits a new comment */
  onSubmit: (content: string) => void;
  /** Called when the user cancels adding a comment */
  onCancel: () => void;
  /** Called when the user deletes an existing comment */
  onDelete: (commentId: string) => void;
}

/**
 * Inline comment thread for the PR-style diff viewer.
 * Renders existing comments as styled cards with delete buttons,
 * and optionally shows a textarea form for adding new comments.
 */
export function DiffCommentThread({
  comments,
  isAdding,
  onSubmit,
  onCancel,
  onDelete,
}: DiffCommentThreadProps) {
  const { t } = useTranslation(['taskReview']);
  const [newComment, setNewComment] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Auto-focus textarea when entering add mode */
  useEffect(() => {
    if (isAdding && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isAdding]);

  /** Reset form state when exiting add mode */
  useEffect(() => {
    if (!isAdding) {
      setNewComment('');
    }
  }, [isAdding]);

  /** Handle form submission */
  const handleSubmit = useCallback(() => {
    const trimmed = newComment.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setNewComment('');
  }, [newComment, onSubmit]);

  /** Handle keyboard shortcuts in textarea */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter to submit
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
      // Escape to cancel
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSubmit, onCancel]
  );

  // Don't render anything if there are no comments and not in add mode
  if (comments.length === 0 && !isAdding) {
    return null;
  }

  return (
    <div className="diff-comment-thread">
      {/* Existing comments */}
      {comments.map((comment) => (
        <div key={comment.id} className="diff-comment-card">
          <div className="diff-comment-card-content">{comment.content}</div>
          <div className="diff-comment-card-actions">
            <button
              type="button"
              className="diff-comment-delete-btn"
              onClick={() => onDelete(comment.id)}
              aria-label={t('taskReview:diffViewer.comments.delete', 'Delete comment')}
              title={t('taskReview:diffViewer.comments.delete', 'Delete comment')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ))}

      {/* Add comment form */}
      {isAdding && (
        <div className="diff-comment-form">
          <textarea
            ref={textareaRef}
            className="diff-comment-textarea"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(
              'taskReview:diffViewer.comments.placeholder',
              'Leave a review comment...'
            )}
            rows={3}
          />
          <div className="diff-comment-form-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
            >
              {t('taskReview:diffViewer.comments.cancel', 'Cancel')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleSubmit}
              disabled={!newComment.trim()}
            >
              {t('taskReview:diffViewer.comments.submit', 'Submit')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
