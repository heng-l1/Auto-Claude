import { useMemo, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { parse } from 'diff2html';
import type { DiffFile, DiffBlock, DiffLine } from 'diff2html/lib/types';
import { LineType } from 'diff2html/lib/types';
import { AlertTriangle, FileCode, Info, Plus } from 'lucide-react';
import { ScrollArea } from '../../ui/scroll-area';
import { DiffCommentThread } from './DiffCommentThread';
import type { WorktreeDiffFile, ReviewComment } from '../../../../shared/types';

interface DiffCodeViewerProps {
  /** The file to display diffs for (null when no file is selected) */
  file: WorktreeDiffFile | null;
  /** Map of comment key ("filePath:lineNumber:side") to comment arrays */
  comments: Map<string, ReviewComment[]>;
  /** Called when the user submits a new comment */
  onAddComment: (
    filePath: string,
    lineNumber: number,
    side: 'old' | 'new',
    content: string
  ) => void;
  /** Called when the user deletes an existing comment */
  onDeleteComment: (commentId: string) => void;
}

/** Build the map key for comments on a specific line */
function commentKey(
  filePath: string,
  lineNumber: number,
  side: 'old' | 'new'
): string {
  return `${filePath}:${lineNumber}:${side}`;
}

/** Strip the leading +/-/space prefix from diff line content */
function stripPrefix(content: string): string {
  if (content.length === 0) return content;
  const firstChar = content[0];
  if (firstChar === '+' || firstChar === '-' || firstChar === ' ') {
    return content.slice(1);
  }
  return content;
}

/** Get the CSS class for a diff line row based on its type */
function lineRowClass(type: LineType): string {
  switch (type) {
    case LineType.INSERT:
      return 'diff-line diff-line-insert';
    case LineType.DELETE:
      return 'diff-line diff-line-delete';
    case LineType.CONTEXT:
      return 'diff-line diff-line-context';
    default:
      return 'diff-line diff-line-context';
  }
}

/** Get the CSS class for line number cells based on line type */
function lineNumberClass(type: LineType): string {
  switch (type) {
    case LineType.INSERT:
      return 'diff-line-number diff-line-number-insert';
    case LineType.DELETE:
      return 'diff-line-number diff-line-number-delete';
    default:
      return 'diff-line-number';
  }
}

/** Determine the line number and side for commenting on a diff line */
function getLineInfo(line: DiffLine): { lineNumber: number; side: 'old' | 'new' } {
  if (line.type === LineType.INSERT) {
    return { lineNumber: line.newNumber as number, side: 'new' };
  }
  if (line.type === LineType.DELETE) {
    return { lineNumber: line.oldNumber as number, side: 'old' };
  }
  // Context lines — use the new side by default
  return { lineNumber: line.newNumber as number, side: 'new' };
}

/**
 * Table-based unified diff renderer for the PR-style code review.
 * Uses diff2html's parse() to convert per-file patch strings into structured
 * diff data, then renders as a table with line numbers, hover-to-comment buttons,
 * and inline comment threads.
 */
export function DiffCodeViewer({
  file,
  comments,
  onAddComment,
  onDeleteComment,
}: DiffCodeViewerProps) {
  const { t } = useTranslation(['taskReview']);
  const [addingCommentAt, setAddingCommentAt] = useState<{
    filePath: string;
    lineNumber: number;
    side: 'old' | 'new';
  } | null>(null);

  /** Parse the file's patch into structured diff data */
  const parsedFiles = useMemo((): DiffFile[] => {
    if (!file?.patch) return [];
    try {
      return parse(file.patch);
    } catch {
      return [];
    }
  }, [file?.patch]);

  /** Check if the parsed file is binary */
  const isBinary = useMemo(() => {
    return parsedFiles.length > 0 && parsedFiles[0].isBinary === true;
  }, [parsedFiles]);

  /** Handle clicking the '+' button to start adding a comment */
  const handleStartComment = useCallback(
    (filePath: string, lineNumber: number, side: 'old' | 'new') => {
      setAddingCommentAt({ filePath, lineNumber, side });
    },
    []
  );

  /** Handle submitting a new comment */
  const handleSubmitComment = useCallback(
    (content: string) => {
      if (!addingCommentAt) return;
      onAddComment(
        addingCommentAt.filePath,
        addingCommentAt.lineNumber,
        addingCommentAt.side,
        content
      );
      setAddingCommentAt(null);
    },
    [addingCommentAt, onAddComment]
  );

  /** Handle canceling the add-comment form */
  const handleCancelComment = useCallback(() => {
    setAddingCommentAt(null);
  }, []);

  // Reset adding state when file changes
  const _currentPath = file?.path;
  useEffect(() => {
    setAddingCommentAt(null);
  }, []);

  // --- Empty states ---

  // No file selected
  if (!file) {
    return (
      <div className="diff-empty-state">
        <FileCode className="diff-empty-state-icon" />
        <span>
          {t(
            'taskReview:diffViewer.noFileSelected',
            'Select a file to view changes'
          )}
        </span>
      </div>
    );
  }

  // Truncated file (too large)
  if (file.truncated) {
    return (
      <div className="diff-empty-state">
        <AlertTriangle className="diff-empty-state-icon" />
        <div className="diff-info-banner diff-info-banner-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {t(
              'taskReview:diffViewer.fileTruncated',
              'File too large to display (exceeds size limit)'
            )}
          </span>
        </div>
      </div>
    );
  }

  // Binary file
  if (isBinary) {
    return (
      <div className="diff-empty-state">
        <Info className="diff-empty-state-icon" />
        <div className="diff-info-banner diff-info-banner-info">
          <Info className="h-4 w-4 shrink-0" />
          <span>
            {t('taskReview:diffViewer.binaryFile', 'Binary file changed')}
          </span>
        </div>
      </div>
    );
  }

  // No patch data available
  if (!file.patch || parsedFiles.length === 0 || parsedFiles[0].blocks.length === 0) {
    return (
      <div className="diff-empty-state">
        <Info className="diff-empty-state-icon" />
        <div className="diff-info-banner diff-info-banner-info">
          <Info className="h-4 w-4 shrink-0" />
          <span>
            {t(
              'taskReview:diffViewer.noPatch',
              'No diff available for this file'
            )}
          </span>
        </div>
      </div>
    );
  }

  const diffFile = parsedFiles[0];
  const currentFilePath = file.path;

  return (
    <ScrollArea className="diff-viewer-code-panel">
      <table className="diff-table">
        <tbody>
          {diffFile.blocks.map((block: DiffBlock, blockIdx: number) => (
            <HunkBlock
              key={blockIdx}
              block={block}
              filePath={currentFilePath}
              comments={comments}
              addingCommentAt={addingCommentAt}
              onStartComment={handleStartComment}
              onSubmitComment={handleSubmitComment}
              onCancelComment={handleCancelComment}
              onDeleteComment={onDeleteComment}
            />
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

// --- Sub-components ---

interface HunkBlockProps {
  block: DiffBlock;
  filePath: string;
  comments: Map<string, ReviewComment[]>;
  addingCommentAt: {
    filePath: string;
    lineNumber: number;
    side: 'old' | 'new';
  } | null;
  onStartComment: (
    filePath: string,
    lineNumber: number,
    side: 'old' | 'new'
  ) => void;
  onSubmitComment: (content: string) => void;
  onCancelComment: () => void;
  onDeleteComment: (commentId: string) => void;
}

/** Renders a single hunk (block) of the diff: header row + diff lines */
function HunkBlock({
  block,
  filePath,
  comments,
  addingCommentAt,
  onStartComment,
  onSubmitComment,
  onCancelComment,
  onDeleteComment,
}: HunkBlockProps) {
  return (
    <>
      {/* Hunk header row (@@ -x,y +a,b @@) */}
      <tr className="diff-hunk-header">
        <td className="diff-line-number" />
        <td className="diff-line-number" />
        <td className="diff-line-content">{block.header}</td>
      </tr>

      {/* Diff lines */}
      {block.lines.map((line: DiffLine, lineIdx: number) => {
        const { lineNumber, side } = getLineInfo(line);
        const key = commentKey(filePath, lineNumber, side);
        const lineComments = comments.get(key) || [];
        const isAddingHere =
          addingCommentAt?.filePath === filePath &&
          addingCommentAt?.lineNumber === lineNumber &&
          addingCommentAt?.side === side;

        return (
          <DiffLineRow
            key={lineIdx}
            line={line}
            filePath={filePath}
            lineNumber={lineNumber}
            side={side}
            lineComments={lineComments}
            isAddingComment={isAddingHere}
            onStartComment={onStartComment}
            onSubmitComment={onSubmitComment}
            onCancelComment={onCancelComment}
            onDeleteComment={onDeleteComment}
          />
        );
      })}
    </>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
  filePath: string;
  lineNumber: number;
  side: 'old' | 'new';
  lineComments: ReviewComment[];
  isAddingComment: boolean;
  onStartComment: (
    filePath: string,
    lineNumber: number,
    side: 'old' | 'new'
  ) => void;
  onSubmitComment: (content: string) => void;
  onCancelComment: () => void;
  onDeleteComment: (commentId: string) => void;
}

/** Renders a single diff line row with line numbers, content, comment button, and comment thread */
function DiffLineRow({
  line,
  filePath,
  lineNumber,
  side,
  lineComments,
  isAddingComment,
  onStartComment,
  onSubmitComment,
  onCancelComment,
  onDeleteComment,
}: DiffLineRowProps) {
  const { t } = useTranslation(['taskReview']);
  const hasThread = lineComments.length > 0 || isAddingComment;

  return (
    <>
      {/* Main diff line row */}
      <tr className={lineRowClass(line.type)}>
        {/* Old line number */}
        <td className={lineNumberClass(line.type)}>
          {line.oldNumber ?? ''}
        </td>
        {/* New line number */}
        <td className={lineNumberClass(line.type)}>
          {line.newNumber ?? ''}
        </td>
        {/* Code content with hover-to-comment button */}
        <td className="diff-line-content">
          {stripPrefix(line.content)}
          <button
            type="button"
            className="diff-add-comment-btn"
            onClick={() => onStartComment(filePath, lineNumber, side)}
            aria-label={t(
              'taskReview:diffViewer.comments.add',
              'Add comment'
            )}
            title={t('taskReview:diffViewer.comments.add', 'Add comment')}
          >
            <Plus className="h-3 w-3" />
          </button>
        </td>
      </tr>

      {/* Comment thread row (rendered below the line if comments exist or adding) */}
      {hasThread && (
        <tr className="diff-comment-thread-row">
          <td className="diff-line-number" />
          <td className="diff-line-number" />
          <td>
            <DiffCommentThread
              comments={lineComments}
              isAdding={isAddingComment}
              onSubmit={onSubmitComment}
              onCancel={onCancelComment}
              onDelete={onDeleteComment}
            />
          </td>
        </tr>
      )}
    </>
  );
}
