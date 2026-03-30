import { useState, useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { Settings2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from './ui/context-menu';
import { TAB_COLORS, TAB_GROUP_COLORS } from '../../shared/constants/config';
import type { Project, TabGroup } from '../../shared/types';
import { useTerminalStore } from '../stores/terminal-store';

interface SortableProjectTabProps {
  project: Project;
  isActive: boolean;
  canClose: boolean;
  tabIndex: number;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  // Optional control props for active tab
  onSettingsClick?: () => void;
  /** Callback when user renames the tab. Pass undefined to clear custom name. */
  onRename?: (name: string | undefined) => void;
  /** When true, enter edit mode (for F2 shortcut support from parent) */
  isRenaming?: boolean;
  /** Notify parent when editing ends (so parent can clear renamingProjectId) */
  onRenameComplete?: () => void;
  /** Callback when user changes the tab color via context menu. Pass undefined to remove color. */
  onColorChange?: (color: string | undefined) => void;
  /** All existing tab groups for context menu submenus */
  tabGroups?: TabGroup[];
  /** The group this tab currently belongs to (undefined if ungrouped) */
  currentGroup?: TabGroup;
  /** Callback to create a new group with this tab */
  onCreateGroup?: (tabId: string) => void;
  /** Callback to add this tab to an existing group */
  onAddToGroup?: (tabId: string, groupId: string) => void;
  /** Callback to remove this tab from its current group */
  onRemoveFromGroup?: (tabId: string) => void;
  /** Callback to move this tab to a different group */
  onMoveToGroup?: (tabId: string, groupId: string) => void;
}

// Detect if running on macOS for keyboard shortcut display
const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const modKey = isMac ? '⌘' : 'Ctrl+';

const MAX_TAB_NAME_LENGTH = 50;

export function SortableProjectTab({
  project,
  isActive,
  canClose,
  tabIndex,
  onSelect,
  onClose,
  onSettingsClick,
  onRename,
  isRenaming,
  onRenameComplete,
  onColorChange,
  tabGroups,
  currentGroup,
  onCreateGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onMoveToGroup
}: SortableProjectTabProps) {
  const { t } = useTranslation('common');
  // Derive display name from custom tab name or project name
  const displayName = project.settings?.customTabName || project.name;

  // Build tooltip with keyboard shortcut hint (only for tabs 1-9)
  const shortcutHint = tabIndex < 9 ? `${modKey}${tabIndex + 1}` : '';
  const closeShortcut = `${modKey}W`;

  // Resolve color tint config from project settings
  const tabColorConfig = TAB_COLORS.find(c => c.id === project.settings?.tabColor);

  // Direct store subscription for project-scoped terminal activity alerts.
  // Returns primitive boolean — no useShallow needed, re-renders only when value changes.
  const hasTerminalActivity = useTerminalStore(
    (state) => state.terminals.some(
      t => t.hasActivityAlert === true && t.projectPath === project.path
    )
  );

  // Inline rename state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: project.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Prevent z-index stacking issues during drag
    zIndex: isDragging ? 50 : undefined
  };

  // Enter edit mode when isRenaming prop becomes true (F2 shortcut from parent)
  useEffect(() => {
    if (isRenaming && !isEditing) {
      setIsEditing(true);
      setEditValue(displayName);
    }
  }, [isRenaming, isEditing, displayName]);

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Cancel edit if dragging starts
  useEffect(() => {
    if (isDragging && isEditing) {
      setIsEditing(false);
      onRenameComplete?.();
    }
  }, [isDragging, isEditing, onRenameComplete]);

  const handleSave = () => {
    const trimmed = editValue.trim().slice(0, MAX_TAB_NAME_LENGTH);
    // Pass undefined to clear custom name (revert to project.name)
    onRename?.(trimmed || undefined);
    setIsEditing(false);
    onRenameComplete?.();
  };

  const handleCancel = () => {
    setEditValue(displayName);
    setIsEditing(false);
    onRenameComplete?.();
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

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRename) {
      setIsEditing(true);
      setEditValue(displayName);
    }
  };

  // Determine if any group management context menu items will render (for separator visibility)
  const otherGroups = tabGroups?.filter(g => g.id !== currentGroup?.id) ?? [];
  const hasGroupMenuItems = currentGroup
    ? !!(onRemoveFromGroup || (onMoveToGroup && otherGroups.length > 0))
    : !!(onCreateGroup || (onAddToGroup && tabGroups && tabGroups.length > 0));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          data-tab-id={project.id}
          className={cn(
            'group relative flex items-center min-w-0',
            'flex-shrink-0 w-[160px]',
            'border-r border-border last:border-r-0',
            'touch-none transition-all duration-200',
            isDragging && 'opacity-60 scale-[0.98] shadow-lg',
            tabColorConfig?.bg
          )}
          {...attributes}
        >
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  'flex-1 flex items-center gap-1 sm:gap-2',
                  // Responsive padding: tighter on mobile, normal on desktop
                  'px-2 sm:px-3 md:px-4 py-2 sm:py-2.5',
                  'text-xs sm:text-sm',
                  'min-w-0 truncate hover:bg-muted/50 transition-colors',
                  'border-b-2 border-transparent cursor-pointer',
                  isActive && [
                    'bg-muted/60 border-b-primary text-foreground',
                    'hover:bg-muted/70'
                  ],
                  !isActive && [
                    'text-muted-foreground',
                    'hover:text-foreground'
                  ]
                )}
                onClick={onSelect}
              >
                {/* Drag handle - visible on hover, hidden on mobile */}
                <div
                  {...listeners}
                  className={cn(
                    'hidden sm:block',
                    'opacity-0 group-hover:opacity-60 transition-opacity',
                    'cursor-grab active:cursor-grabbing',
                    'w-1 h-4 bg-muted-foreground rounded-full flex-shrink-0'
                  )}
                />
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
                    maxLength={MAX_TAB_NAME_LENGTH}
                    placeholder={t('projectTab.renameTabPlaceholder')}
                    aria-label={t('projectTab.renameTabAriaLabel')}
                    className={cn(
                      'truncate font-medium bg-transparent border-none outline-none',
                      'w-full min-w-0 p-0 m-0',
                      'text-inherit',
                      'focus:ring-1 focus:ring-primary rounded-sm px-0.5'
                    )}
                  />
                ) : (
                  <span
                    className="truncate font-medium"
                    onDoubleClick={handleDoubleClick}
                  >
                    {displayName}
                  </span>
                )}
                {hasTerminalActivity && !isActive && (
                  <span className="relative flex h-2 w-2 flex-shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-2">
              <span>{displayName}</span>
              {shortcutHint && (
                <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border border-border font-mono">
                  {shortcutHint}
                </kbd>
              )}
            </TooltipContent>
          </Tooltip>

          {/* Active tab controls - settings and archive, always accessible */}
          {isActive && (
            <div className="flex items-center gap-0.5 mr-0.5 sm:mr-1 flex-shrink-0">
              {/* Settings icon - responsive sizing */}
              {onSettingsClick && (
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'h-5 w-5 sm:h-6 sm:w-6 p-0 rounded',
                        'flex items-center justify-center',
                        'text-muted-foreground hover:text-foreground',
                        'hover:bg-muted/50 transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSettingsClick();
                      }}
                      aria-label={t('projectTab.settings')}
                    >
                      <Settings2 className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <span>{t('projectTab.settings')}</span>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}

          {canClose && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'h-5 w-5 sm:h-6 sm:w-6 p-0 mr-0.5 sm:mr-1',
                    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                    'transition-opacity duration-200 rounded flex-shrink-0',
                    'hover:bg-destructive hover:text-destructive-foreground',
                    'flex items-center justify-center',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                    isActive && 'opacity-100'
                  )}
                  onClick={onClose}
                  aria-label={t('projectTab.closeTabAriaLabel')}
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex items-center gap-2">
                <span>{t('projectTab.closeTab')}</span>
                <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border border-border font-mono">
                  {closeShortcut}
                </kbd>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {/* Tab group management items */}
        {!currentGroup && (
          <>
            {onCreateGroup && (
              <ContextMenuItem onClick={() => onCreateGroup(project.id)}>
                {t('tabGroup.addToNewGroup')}
              </ContextMenuItem>
            )}
            {onAddToGroup && tabGroups && tabGroups.length > 0 && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  {t('tabGroup.addToGroup')}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {tabGroups.map((group) => {
                    const groupColor = TAB_GROUP_COLORS.find(c => c.id === group.color);
                    return (
                      <ContextMenuItem
                        key={group.id}
                        onClick={() => onAddToGroup(project.id, group.id)}
                      >
                        <span className={cn('w-3 h-3 rounded-full inline-block mr-2', groupColor?.chip)} />
                        {group.name}
                      </ContextMenuItem>
                    );
                  })}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
          </>
        )}
        {currentGroup && (
          <>
            {onRemoveFromGroup && (
              <ContextMenuItem onClick={() => onRemoveFromGroup(project.id)}>
                {t('tabGroup.removeFromGroup')}
              </ContextMenuItem>
            )}
            {onMoveToGroup && tabGroups && tabGroups.filter(g => g.id !== currentGroup.id).length > 0 && (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  {t('tabGroup.moveToGroup')}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {tabGroups
                    .filter((group) => group.id !== currentGroup.id)
                    .map((group) => {
                      const groupColor = TAB_GROUP_COLORS.find(c => c.id === group.color);
                      return (
                        <ContextMenuItem
                          key={group.id}
                          onClick={() => onMoveToGroup(project.id, group.id)}
                        >
                          <span className={cn('w-3 h-3 rounded-full inline-block mr-2', groupColor?.chip)} />
                          {group.name}
                        </ContextMenuItem>
                      );
                    })}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
          </>
        )}

        {hasGroupMenuItems && <ContextMenuSeparator />}

        {onColorChange && (
          <>
            <ContextMenuLabel>{t('projectTab.setColor')}</ContextMenuLabel>
            <div className="grid grid-cols-4 gap-1 px-2 py-1">
              {TAB_COLORS.map((color) => (
                <button
                  key={color.id}
                  className={cn(
                    'w-6 h-6 rounded border-2 transition-all',
                    color.swatch,
                    project.settings?.tabColor === color.id
                      ? 'border-foreground scale-110'
                      : 'border-transparent hover:scale-105'
                  )}
                  onClick={() => onColorChange(color.id)}
                  title={t(color.labelKey)}
                  aria-label={`${t('projectTab.setColor')}: ${t(color.labelKey)}`}
                />
              ))}
              <button
                className={cn(
                  'w-6 h-6 rounded border-2 transition-all flex items-center justify-center',
                  !project.settings?.tabColor
                    ? 'border-foreground scale-110'
                    : 'border-border hover:scale-105'
                )}
                onClick={() => onColorChange(undefined)}
                title={t('projectTab.removeColor')}
                aria-label={t('projectTab.removeColor')}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}