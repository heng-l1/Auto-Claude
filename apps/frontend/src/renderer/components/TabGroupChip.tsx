import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from './ui/context-menu';
import { TAB_GROUP_COLORS } from '../../shared/constants/config';
import type { TabGroup } from '../../shared/types';

interface TabGroupChipProps {
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

const MAX_GROUP_NAME_LENGTH = 50;

export function TabGroupChip({
  group,
  tabCount,
  onToggleCollapsed,
  onRename,
  onSetColor,
  onUngroup,
  onCloseGroup,
}: TabGroupChipProps) {
  const { t } = useTranslation('common');

  // Resolve color config from group's color
  const colorConfig = TAB_GROUP_COLORS.find(c => c.id === group.color);

  // Inline rename state (matches SortableProjectTab pattern)
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    const trimmed = editValue.trim().slice(0, MAX_GROUP_NAME_LENGTH);
    if (trimmed) {
      onRename(group.id, trimmed);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(group.name);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isEditing) {
      onToggleCollapsed(group.id);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
    setEditValue(group.name);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1.5',
            'px-2 sm:px-3 py-1.5 sm:py-2',
            'text-xs sm:text-sm',
            'rounded-md cursor-pointer select-none',
            'border-b-2 transition-colors',
            'hover:brightness-95',
            colorConfig?.bg,
            colorConfig?.border
          )}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          aria-label={t('tabGroup.groupChipAriaLabel', { name: group.name, count: tabCount })}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleCollapsed(group.id);
            }
          }}
        >
          {/* Color dot */}
          <span
            className={cn(
              'w-2.5 h-2.5 rounded-full flex-shrink-0',
              colorConfig?.chip
            )}
          />

          {/* Name or inline rename input */}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSave}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              maxLength={MAX_GROUP_NAME_LENGTH}
              placeholder={t('tabGroup.renamePlaceholder')}
              aria-label={t('tabGroup.renameGroupAriaLabel', { name: group.name })}
              className={cn(
                'truncate font-medium bg-transparent border-none outline-none',
                'w-full min-w-[60px] max-w-[120px] p-0 m-0',
                'text-inherit',
                'focus:ring-1 focus:ring-primary rounded-sm px-0.5'
              )}
            />
          ) : (
            <span className="truncate font-medium whitespace-nowrap">
              {group.collapsed
                ? t('tabGroup.collapsedCount', { name: group.name, count: tabCount })
                : group.name}
            </span>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {/* Rename */}
        <ContextMenuItem
          onClick={() => {
            setIsEditing(true);
            setEditValue(group.name);
          }}
        >
          {t('tabGroup.renameGroup')}
        </ContextMenuItem>

        {/* Change color submenu */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {t('tabGroup.changeColor')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {TAB_GROUP_COLORS.map((color) => (
              <ContextMenuItem
                key={color.id}
                onClick={() => onSetColor(group.id, color.id)}
              >
                <span className={cn('w-3 h-3 rounded-full inline-block mr-2', color.chip)} />
                {t(color.labelKey)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        {/* Ungroup (dissolve) */}
        <ContextMenuItem onClick={() => onUngroup(group.id)}>
          {t('tabGroup.ungroup')}
        </ContextMenuItem>

        {/* Close group */}
        <ContextMenuItem onClick={() => onCloseGroup(group.id)}>
          {t('tabGroup.closeGroup')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
