import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode, MessageSquare } from 'lucide-react';
import { ScrollArea } from '../../ui/scroll-area';
import { Badge } from '../../ui/badge';
import { cn } from '../../../lib/utils';
import type { WorktreeDiffFile, ReviewComment } from '../../../../shared/types';

interface DiffFileTreeProps {
  files: WorktreeDiffFile[];
  selectedIndex: number;
  comments: Map<string, ReviewComment[]>;
  onSelectFile: (index: number) => void;
}

/**
 * Scrollable file tree sidebar for the PR-style diff viewer.
 * Displays changed files with status icons, +/- line counts,
 * comment count badges, active file highlighting, and keyboard navigation.
 */
export function DiffFileTree({
  files,
  selectedIndex,
  comments,
  onSelectFile,
}: DiffFileTreeProps) {
  const { t } = useTranslation(['taskReview']);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  /** Count comments for a given file path */
  const getFileCommentCount = useCallback(
    (filePath: string): number => {
      let count = 0;
      for (const [key, threadComments] of comments) {
        if (key.startsWith(`${filePath}:`)) {
          count += threadComments.length;
        }
      }
      return count;
    },
    [comments]
  );

  /** Scroll the active item into view when selectedIndex changes */
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  /** Keyboard navigation: ArrowUp / ArrowDown to move between files */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (files.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(selectedIndex + 1, files.length - 1);
        onSelectFile(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(selectedIndex - 1, 0);
        onSelectFile(prev);
      }
    },
    [files.length, selectedIndex, onSelectFile]
  );

  /** Store a ref for each file item button */
  const setItemRef = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      if (el) {
        itemRefs.current.set(index, el);
      } else {
        itemRefs.current.delete(index);
      }
    },
    []
  );

  /** Extract just the filename from a full path */
  const getFileName = (filePath: string): string => {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  };

  return (
    <div className="diff-viewer-sidebar">
      <div className="diff-viewer-sidebar-header">
        {t('taskReview:diffViewer.summary', { count: files.length })}
      </div>
      <ScrollArea className="flex-1">
        {/* biome-ignore lint/a11y/useSemanticElements: file tree uses custom keyboard navigation */}
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('taskReview:diffViewer.title')}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="py-1 px-1 outline-none"
        >
          {files.map((file, index) => {
            const isActive = index === selectedIndex;
            const commentCount = getFileCommentCount(file.path);
            const fileName = getFileName(file.path);
            const displayName =
              file.status === 'renamed' && file.oldPath
                ? `${getFileName(file.oldPath)} → ${fileName}`
                : fileName;

            return (
              <button
                key={file.path}
                ref={setItemRef(index)}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => onSelectFile(index)}
                title={
                  file.status === 'renamed' && file.oldPath
                    ? t('taskReview:diffViewer.renamedFrom', { oldPath: file.oldPath })
                    : file.path
                }
                className={cn(
                  'diff-file-tree-item w-full text-left',
                  isActive && 'diff-file-tree-item-active'
                )}
              >
                <FileCode
                  className={cn(
                    'h-4 w-4 shrink-0',
                    file.status === 'added' && 'text-success',
                    file.status === 'deleted' && 'text-destructive',
                    file.status === 'modified' && 'text-info',
                    file.status === 'renamed' && 'text-warning'
                  )}
                />
                <span className="diff-file-tree-filename">{displayName}</span>
                <div className="diff-file-tree-stats">
                  {commentCount > 0 && (
                    <Badge
                      variant="purple"
                      className="px-1.5 py-0 text-[0.625rem] leading-4 gap-0.5"
                    >
                      <MessageSquare className="h-2.5 w-2.5" />
                      {commentCount}
                    </Badge>
                  )}
                  <span className="diff-file-tree-additions">+{file.additions}</span>
                  <span className="diff-file-tree-deletions">-{file.deletions}</span>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
