import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '../lib/utils';
import { TabGroupChip } from './TabGroupChip';
import type { TabGroup } from '../../shared/types';

interface SortableTabGroupChipProps {
  /** The tab group data */
  group: TabGroup;
  /** Number of tabs in this group */
  tabCount: number;
  /** Toggle collapse/expand */
  onToggleCollapsed: (groupId: string) => void;
  /** Rename the group */
  onRename: (groupId: string, name: string) => void;
  /** Change the group color */
  onSetColor: (groupId: string, color: string) => void;
  /** Dissolve the group (tabs stay) */
  onUngroup: (groupId: string) => void;
  /** Close all tabs in the group */
  onCloseGroup: (groupId: string) => void;
}

export function SortableTabGroupChip({
  group,
  tabCount,
  onToggleCollapsed,
  onRename,
  onSetColor,
  onUngroup,
  onCloseGroup,
}: SortableTabGroupChipProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: `group:${group.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Prevent z-index stacking issues during drag
    zIndex: isDragging ? 50 : undefined
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'touch-none transition-all duration-200',
        isDragging && 'opacity-60 scale-[0.98] shadow-lg'
      )}
      {...attributes}
      {...listeners}
    >
      <TabGroupChip
        group={group}
        tabCount={tabCount}
        onToggleCollapsed={onToggleCollapsed}
        onRename={onRename}
        onSetColor={onSetColor}
        onUngroup={onUngroup}
        onCloseGroup={onCloseGroup}
      />
    </div>
  );
}
