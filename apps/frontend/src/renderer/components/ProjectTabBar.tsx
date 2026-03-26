import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { SortableProjectTab } from './SortableProjectTab';
import { SortableTabGroupChip } from './SortableTabGroupChip';
import { UsageIndicator } from './UsageIndicator';
import { AuthStatusIndicator } from './AuthStatusIndicator';
import { useProjectStore } from '../stores/project-store';
import { TAB_GROUP_COLORS } from '../../shared/constants/config';
import type { Project, TabGroup, TabGroupColor } from '../../shared/types';

interface ProjectTabBarProps {
  projects: Project[];
  activeProjectId: string | null;
  onProjectSelect: (projectId: string) => void;
  onProjectClose: (projectId: string) => void;
  onAddProject: () => void;
  className?: string;
  // Control props for active tab
  onSettingsClick?: () => void;
  /** Callback when user renames a tab. Pass undefined to clear custom name. */
  onRenameTab?: (projectId: string, name: string | undefined) => void;
  /** Callback when user changes the tab color. Pass undefined to remove color. */
  onTabColorChange?: (projectId: string, color: string | undefined) => void;
}

export function ProjectTabBar({
  projects,
  activeProjectId,
  onProjectSelect,
  onProjectClose,
  onAddProject,
  className,
  onSettingsClick,
  onRenameTab,
  onTabColorChange
}: ProjectTabBarProps) {
  const { t } = useTranslation('common');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);

  // Tab group state from store (subscribe to trigger re-renders on changes)
  const tabGroups = useProjectStore(state => state.tabGroups);
  // Subscribe to tabOrder so layout re-computes when order changes
  useProjectStore(state => state.tabOrder);

  // Tab group selectors from store
  const getTabLayout = useProjectStore(state => state.getTabLayout);
  const getVisibleTabs = useProjectStore(state => state.getVisibleTabs);
  const findGroupByTabId = useProjectStore(state => state.findGroupByTabId);

  // Tab group actions from store
  const createTabGroup = useProjectStore(state => state.createTabGroup);
  const addTabToGroup = useProjectStore(state => state.addTabToGroup);
  const removeTabFromGroup = useProjectStore(state => state.removeTabFromGroup);
  const moveTabToGroup = useProjectStore(state => state.moveTabToGroup);
  const toggleTabGroupCollapsed = useProjectStore(state => state.toggleTabGroupCollapsed);
  const renameTabGroup = useProjectStore(state => state.renameTabGroup);
  const storeSetTabGroupColor = useProjectStore(state => state.setTabGroupColor);
  const removeTabGroup = useProjectStore(state => state.removeTabGroup);
  const closeTabGroup = useProjectStore(state => state.closeTabGroup);

  // Compute group-aware tab layout and project lookup map
  const tabLayout = getTabLayout();
  const projectMap = new Map(projects.map(p => [p.id, p]));

  // Pre-compute visual tab indices for keyboard shortcut hints.
  // Only visible tabs (ungrouped + expanded group members) get an index.
  let visualTabIndex = 0;
  const visualIndexMap = new Map<string, number>();
  for (const entry of tabLayout) {
    if (entry.type === 'group') {
      if (!entry.group.collapsed) {
        for (const projectId of entry.projectIds) {
          visualIndexMap.set(projectId, visualTabIndex++);
        }
      }
    } else {
      visualIndexMap.set(entry.projectId, visualTabIndex++);
    }
  }

  // Keyboard shortcuts for tab navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if in input fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      // F2: Rename active tab
      if (e.key === 'F2' && activeProjectId) {
        e.preventDefault();
        setRenamingProjectId(activeProjectId);
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      // Cmd/Ctrl + 1-9: Switch to visible tab N (by visual position)
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const visibleTabs = getVisibleTabs();
        const index = parseInt(e.key, 10) - 1;
        if (index < visibleTabs.length) {
          onProjectSelect(visibleTabs[index]);
        }
        return;
      }

      // Cmd/Ctrl + Tab: Next visible tab
      // Cmd/Ctrl + Shift + Tab: Previous visible tab
      // Skips members of collapsed groups
      if (e.key === 'Tab') {
        e.preventDefault();
        const visibleTabs = getVisibleTabs();
        if (visibleTabs.length === 0) return;

        const currentIndex = visibleTabs.indexOf(activeProjectId ?? '');
        if (currentIndex === -1) {
          // Active tab is in a collapsed group or not found — select first visible tab
          onProjectSelect(visibleTabs[0]);
          return;
        }

        const nextIndex = e.shiftKey
          ? (currentIndex - 1 + visibleTabs.length) % visibleTabs.length
          : (currentIndex + 1) % visibleTabs.length;
        onProjectSelect(visibleTabs[nextIndex]);
        return;
      }

      // Cmd/Ctrl + W: Close current tab (only if more than one tab)
      if (e.key === 'w' && activeProjectId && projects.length > 1) {
        e.preventDefault();
        onProjectClose(activeProjectId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projects, activeProjectId, onProjectSelect, onProjectClose, getVisibleTabs]);

  if (projects.length === 0) {
    return null;
  }

  /** Render a SortableProjectTab with all standard and group-related props */
  const renderTab = (project: Project, group?: TabGroup) => {
    const isActiveTab = activeProjectId === project.id;
    const currentGroup = group ?? findGroupByTabId(project.id);
    return (
      <SortableProjectTab
        key={project.id}
        project={project}
        isActive={isActiveTab}
        canClose={projects.length > 1}
        tabIndex={visualIndexMap.get(project.id) ?? 0}
        onSelect={() => onProjectSelect(project.id)}
        onClose={(e) => {
          e.stopPropagation();
          onProjectClose(project.id);
        }}
        onSettingsClick={isActiveTab ? onSettingsClick : undefined}
        onRename={onRenameTab ? (name) => onRenameTab(project.id, name) : undefined}
        isRenaming={project.id === renamingProjectId}
        onRenameComplete={() => setRenamingProjectId(null)}
        onColorChange={onTabColorChange ? (color) => onTabColorChange(project.id, color) : undefined}
        tabGroups={tabGroups}
        currentGroup={currentGroup}
        onCreateGroup={(tabId) => createTabGroup([tabId])}
        onAddToGroup={addTabToGroup}
        onRemoveFromGroup={removeTabFromGroup}
        onMoveToGroup={moveTabToGroup}
      />
    );
  };

  return (
    <div className={cn(
      'flex items-center border-b border-border bg-background',
      'overflow-x-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent',
      className
    )}>
      <div className="flex items-center flex-1 min-w-0">
        {tabLayout.map((entry) => {
          if (entry.type === 'group') {
            const colorConfig = TAB_GROUP_COLORS.find(c => c.id === entry.group.color);
            return (
              <div
                key={`group:${entry.group.id}`}
                className={cn(
                  'flex items-center',
                  colorConfig?.bg,
                  'border-b-2',
                  colorConfig?.border
                )}
              >
                <SortableTabGroupChip
                  group={entry.group}
                  tabCount={entry.projectIds.length}
                  onToggleCollapsed={toggleTabGroupCollapsed}
                  onRename={renameTabGroup}
                  onSetColor={(groupId, color) => storeSetTabGroupColor(groupId, color as TabGroupColor)}
                  onUngroup={removeTabGroup}
                  onCloseGroup={closeTabGroup}
                />
                {!entry.group.collapsed && entry.projectIds.map((projectId) => {
                  const project = projectMap.get(projectId);
                  if (!project) return null;
                  return renderTab(project, entry.group);
                })}
              </div>
            );
          }

          // Standalone tab (not in any group)
          const project = projectMap.get(entry.projectId);
          if (!project) return null;
          return renderTab(project);
        })}
      </div>

      <div className="flex items-center gap-2 px-2 py-1 flex-shrink-0 border-l border-border">
        <AuthStatusIndicator />
        <UsageIndicator />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onAddProject}
          aria-label={t('projectTab.addProjectAriaLabel')}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
