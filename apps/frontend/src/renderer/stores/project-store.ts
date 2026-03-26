import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Project, ProjectSettings, AutoBuildVersionInfo, InitializationResult, TabGroup, TabGroupColor } from '../../shared/types';
import { TAB_GROUP_COLORS } from '../../shared/constants/config';

/** A single entry in the tab layout - either a standalone tab or a group with its member tabs */
export type TabLayoutItem =
  | { type: 'tab'; projectId: string }
  | { type: 'group'; group: TabGroup; projectIds: string[] };

// localStorage keys for persisting project state (legacy - now using IPC)
const LAST_SELECTED_PROJECT_KEY = 'lastSelectedProjectId';

// Debounce timer for saving tab state
let saveTabStateTimeout: ReturnType<typeof setTimeout> | null = null;

// Rotating color index for automatic tab group color assignment
let nextGroupColorIndex = 0;

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;
  isLoading: boolean;
  error: string | null;

  // Tab state
  openProjectIds: string[]; // Array of open project IDs
  activeProjectId: string | null; // Currently active tab
  tabOrder: string[]; // Order of tabs for drag and drop
  tabGroups: TabGroup[]; // Chrome-style tab groups

  // Actions
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => void;
  selectProject: (projectId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Tab management actions
  openProjectTab: (projectId: string) => void;
  closeProjectTab: (projectId: string) => void;
  setActiveProject: (projectId: string | null) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  restoreTabState: () => void;

  // Tab group actions
  createTabGroup: (tabIds: string[], name?: string, color?: TabGroupColor) => void;
  removeTabGroup: (groupId: string) => void;
  renameTabGroup: (groupId: string, name: string) => void;
  setTabGroupColor: (groupId: string, color: TabGroupColor) => void;
  toggleTabGroupCollapsed: (groupId: string) => void;
  addTabToGroup: (tabId: string, groupId: string) => void;
  removeTabFromGroup: (tabId: string) => void;
  moveTabToGroup: (tabId: string, groupId: string) => void;
  closeTabGroup: (groupId: string) => void;

  // Tab group selectors
  findGroupByTabId: (tabId: string) => TabGroup | undefined;

  // Selectors
  getSelectedProject: () => Project | undefined;
  getOpenProjects: () => Project[];
  getActiveProject: () => Project | undefined;
  getProjectTabs: () => Project[];
  getTabLayout: () => TabLayoutItem[];
  getSortableItems: () => string[];
  getVisibleTabs: () => string[];
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectId: null,
  isLoading: false,
  error: null,

  // Tab state - initialized empty, loaded via IPC from main process for reliability
  openProjectIds: [],
  activeProjectId: null,
  tabOrder: [],
  tabGroups: [],

  setProjects: (projects) => set({ projects }),

  addProject: (project) =>
    set((state) => ({
      projects: [...state.projects, project]
    })),

  removeProject: (projectId) =>
    set((state) => {
      const isSelectedProject = state.selectedProjectId === projectId;
      // Clear localStorage if we're removing the currently selected project
      if (isSelectedProject) {
        localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
      }
      return {
        projects: state.projects.filter((p) => p.id !== projectId),
        selectedProjectId: isSelectedProject ? null : state.selectedProjectId
      };
    }),

  updateProject: (projectId, updates) =>
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, ...updates } : p
      )
    })),

  selectProject: (projectId) => {
    // Persist to localStorage for restoration on app reload
    if (projectId) {
      localStorage.setItem(LAST_SELECTED_PROJECT_KEY, projectId);
    } else {
      localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
    }
    set({ selectedProjectId: projectId });
  },

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  // Tab management actions
  openProjectTab: (projectId) => {
    const state = get();
    console.log('[ProjectStore] openProjectTab called:', {
      projectId,
      currentOpenProjectIds: state.openProjectIds,
      currentTabOrder: state.tabOrder
    });
    if (!state.openProjectIds.includes(projectId)) {
      const newOpenProjectIds = [...state.openProjectIds, projectId];
      const newTabOrder = state.tabOrder.includes(projectId)
        ? state.tabOrder
        : [...state.tabOrder, projectId];

      console.log('[ProjectStore] Adding new tab:', {
        newOpenProjectIds,
        newTabOrder
      });

      set({
        openProjectIds: newOpenProjectIds,
        tabOrder: newTabOrder,
        activeProjectId: projectId
      });

      // Save to main process (debounced)
      saveTabStateToMain();
    } else {
      console.log('[ProjectStore] Project already open, just activating');
      // Project already open, just make it active
      get().setActiveProject(projectId);
    }
  },

  closeProjectTab: (projectId) => {
    const state = get();
    const newOpenProjectIds = state.openProjectIds.filter(id => id !== projectId);
    const newTabOrder = state.tabOrder.filter(id => id !== projectId);

    // Remove tab from any group and auto-delete empty groups
    let newTabGroups = state.tabGroups.map(g => {
      if (g.tabIds.includes(projectId)) {
        return { ...g, tabIds: g.tabIds.filter(id => id !== projectId) };
      }
      return g;
    });
    newTabGroups = newTabGroups.filter(g => g.tabIds.length > 0);

    // If closing the active project, select another one or null
    let newActiveProjectId = state.activeProjectId;
    if (state.activeProjectId === projectId) {
      const remainingTabs = newTabOrder.length > 0 ? newTabOrder : [];
      newActiveProjectId = remainingTabs.length > 0 ? remainingTabs[0] : null;
    }

    set({
      openProjectIds: newOpenProjectIds,
      tabOrder: newTabOrder,
      tabGroups: newTabGroups,
      activeProjectId: newActiveProjectId
    });

    // Save to main process (debounced)
    saveTabStateToMain();
  },

  setActiveProject: (projectId) => {
    set({ activeProjectId: projectId });
    // Also update selectedProjectId for backward compatibility
    get().selectProject(projectId);
    // Save to main process (debounced)
    saveTabStateToMain();
  },

  reorderTabs: (fromIndex, toIndex) => {
    const state = get();
    const newTabOrder = [...state.tabOrder];
    const [movedTab] = newTabOrder.splice(fromIndex, 1);
    newTabOrder.splice(toIndex, 0, movedTab);

    set({ tabOrder: newTabOrder });
    // Save to main process (debounced)
    saveTabStateToMain();
  },

  restoreTabState: () => {
    // This is now handled by loadTabStateFromMain() called during loadProjects()
    console.log('[ProjectStore] restoreTabState called - now handled by IPC');
  },

  // Tab group actions
  createTabGroup: (tabIds, name, color) => {
    const state = get();

    // Filter to only tabs that exist in tabOrder
    const validTabIds = tabIds.filter(id => state.tabOrder.includes(id));
    if (validTabIds.length === 0) return;

    // Assign color: use provided color, or rotate through the palette
    const groupColor: TabGroupColor = color ?? TAB_GROUP_COLORS[nextGroupColorIndex % TAB_GROUP_COLORS.length].id as TabGroupColor;
    nextGroupColorIndex++;

    const newGroup: TabGroup = {
      id: uuid(),
      name: name ?? 'New group',
      color: groupColor,
      collapsed: false,
      tabIds: validTabIds,
    };

    // Ensure member adjacency in tabOrder:
    // Find position of first member, then cluster all members there
    const firstMemberIndex = state.tabOrder.findIndex(id => validTabIds.includes(id));
    const nonMembers = state.tabOrder.filter(id => !validTabIds.includes(id));
    // Count non-member items before the first member to compute correct insertion point
    const insertAt = state.tabOrder.slice(0, firstMemberIndex).filter(id => !validTabIds.includes(id)).length;
    // Preserve relative order of members from tabOrder
    const orderedMembers = state.tabOrder.filter(id => validTabIds.includes(id));
    const newTabOrder = [
      ...nonMembers.slice(0, insertAt),
      ...orderedMembers,
      ...nonMembers.slice(insertAt),
    ];

    set({
      tabGroups: [...state.tabGroups, newGroup],
      tabOrder: newTabOrder,
    });
    saveTabStateToMain();
  },

  removeTabGroup: (groupId) => {
    const state = get();
    set({
      tabGroups: state.tabGroups.filter(g => g.id !== groupId),
    });
    saveTabStateToMain();
  },

  renameTabGroup: (groupId, name) => {
    const state = get();
    set({
      tabGroups: state.tabGroups.map(g =>
        g.id === groupId ? { ...g, name } : g
      ),
    });
    saveTabStateToMain();
  },

  setTabGroupColor: (groupId, color) => {
    const state = get();
    set({
      tabGroups: state.tabGroups.map(g =>
        g.id === groupId ? { ...g, color } : g
      ),
    });
    saveTabStateToMain();
  },

  toggleTabGroupCollapsed: (groupId) => {
    const state = get();
    const group = state.tabGroups.find(g => g.id === groupId);
    if (!group) return;

    const willCollapse = !group.collapsed;
    let newActiveProjectId = state.activeProjectId;

    if (willCollapse && state.activeProjectId && group.tabIds.includes(state.activeProjectId)) {
      // Active tab is in the collapsing group - find first visible tab outside
      const tabsOutsideCollapsedGroups = state.tabOrder.filter(id => {
        const tabGroup = state.tabGroups.find(g => g.tabIds.includes(id));
        // Tab is outside any group, or in an expanded group that isn't being collapsed
        return !tabGroup || (tabGroup.id !== groupId && !tabGroup.collapsed);
      });

      if (tabsOutsideCollapsedGroups.length > 0) {
        newActiveProjectId = tabsOutsideCollapsedGroups[0];
      } else {
        // All tabs are in collapsed groups - expand the nearest other group and select its first tab
        const firstOtherGroup = state.tabGroups.find(g => g.id !== groupId && g.tabIds.length > 0);
        if (firstOtherGroup) {
          set({
            tabGroups: state.tabGroups.map(g => {
              if (g.id === groupId) return { ...g, collapsed: true };
              if (g.id === firstOtherGroup.id) return { ...g, collapsed: false };
              return g;
            }),
            activeProjectId: firstOtherGroup.tabIds[0],
          });
          if (firstOtherGroup.tabIds[0]) get().selectProject(firstOtherGroup.tabIds[0]);
          saveTabStateToMain();
          return;
        }
      }
    }

    set({
      tabGroups: state.tabGroups.map(g =>
        g.id === groupId ? { ...g, collapsed: willCollapse } : g
      ),
      activeProjectId: newActiveProjectId,
    });
    if (newActiveProjectId !== state.activeProjectId && newActiveProjectId) {
      get().selectProject(newActiveProjectId);
    }
    saveTabStateToMain();
  },

  addTabToGroup: (tabId, groupId) => {
    const state = get();
    const targetGroup = state.tabGroups.find(g => g.id === groupId);
    if (!targetGroup || !state.tabOrder.includes(tabId)) return;
    if (targetGroup.tabIds.includes(tabId)) return; // Already in this group

    // Remove from any prior group
    let updatedGroups = state.tabGroups.map(g => {
      if (g.id !== groupId && g.tabIds.includes(tabId)) {
        return { ...g, tabIds: g.tabIds.filter(id => id !== tabId) };
      }
      return g;
    });
    // Auto-delete empty groups (except target)
    updatedGroups = updatedGroups.filter(g => g.tabIds.length > 0 || g.id === groupId);

    // Add tab to target group
    updatedGroups = updatedGroups.map(g =>
      g.id === groupId ? { ...g, tabIds: [...g.tabIds, tabId] } : g
    );

    // Move tab adjacent to group in tabOrder (after last existing member)
    const tabOrderWithoutTab = state.tabOrder.filter(id => id !== tabId);
    const existingGroupMembers = targetGroup.tabIds;
    let insertIndex = tabOrderWithoutTab.length;
    if (existingGroupMembers.length > 0) {
      const memberIndices = existingGroupMembers
        .map(id => tabOrderWithoutTab.indexOf(id))
        .filter(idx => idx >= 0);
      if (memberIndices.length > 0) {
        insertIndex = Math.max(...memberIndices) + 1;
      }
    }
    const newTabOrder = [
      ...tabOrderWithoutTab.slice(0, insertIndex),
      tabId,
      ...tabOrderWithoutTab.slice(insertIndex),
    ];

    set({
      tabGroups: updatedGroups,
      tabOrder: newTabOrder,
    });
    saveTabStateToMain();
  },

  removeTabFromGroup: (tabId) => {
    const state = get();
    const group = state.tabGroups.find(g => g.tabIds.includes(tabId));
    if (!group) return;

    const updatedTabIds = group.tabIds.filter(id => id !== tabId);

    // Auto-delete group if empty, otherwise update its tabIds
    const updatedGroups = updatedTabIds.length === 0
      ? state.tabGroups.filter(g => g.id !== group.id)
      : state.tabGroups.map(g =>
          g.id === group.id ? { ...g, tabIds: updatedTabIds } : g
        );

    set({ tabGroups: updatedGroups });
    saveTabStateToMain();
  },

  moveTabToGroup: (tabId, groupId) => {
    // Atomic remove from old group + add to new group
    get().addTabToGroup(tabId, groupId);
  },

  closeTabGroup: (groupId) => {
    const state = get();
    const group = state.tabGroups.find(g => g.id === groupId);
    if (!group) return;

    const memberIds = group.tabIds;
    const newOpenProjectIds = state.openProjectIds.filter(id => !memberIds.includes(id));
    const newTabOrder = state.tabOrder.filter(id => !memberIds.includes(id));
    const newTabGroups = state.tabGroups.filter(g => g.id !== groupId);

    // Select nearest tab outside the group if active tab was in it
    let newActiveProjectId = state.activeProjectId;
    if (state.activeProjectId && memberIds.includes(state.activeProjectId)) {
      if (newTabOrder.length > 0) {
        // Find the tab nearest to where the group was positioned
        const groupFirstIndex = state.tabOrder.indexOf(memberIds[0]);
        let closestTab: string | null = null;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (const id of newTabOrder) {
          const distance = Math.abs(state.tabOrder.indexOf(id) - groupFirstIndex);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestTab = id;
          }
        }
        newActiveProjectId = closestTab;
      } else {
        newActiveProjectId = null;
      }
    }

    set({
      openProjectIds: newOpenProjectIds,
      tabOrder: newTabOrder,
      tabGroups: newTabGroups,
      activeProjectId: newActiveProjectId,
    });
    if (newActiveProjectId !== state.activeProjectId && newActiveProjectId) {
      get().selectProject(newActiveProjectId);
    }
    saveTabStateToMain();
  },

  // Tab group selectors
  findGroupByTabId: (tabId) => {
    const state = get();
    return state.tabGroups.find(g => g.tabIds.includes(tabId));
  },

  // Original selectors
  getSelectedProject: () => {
    const state = get();
    return state.projects.find((p) => p.id === state.selectedProjectId);
  },

  // New selectors for tab functionality
  getOpenProjects: () => {
    const state = get();
    return state.projects.filter((p) => state.openProjectIds.includes(p.id));
  },

  getActiveProject: () => {
    const state = get();
    return state.projects.find((p) => p.id === state.activeProjectId);
  },

  getProjectTabs: () => {
    const state = get();
    const orderedProjects = state.tabOrder
      .map(id => state.projects.find(p => p.id === id))
      .filter(Boolean) as Project[];

    // Add any open projects not in tabOrder to the end
    const remainingProjects = state.projects
      .filter(p => state.openProjectIds.includes(p.id) && !state.tabOrder.includes(p.id));

    return [...orderedProjects, ...remainingProjects];
  },

  getTabLayout: () => {
    const state = get();
    const { tabOrder, tabGroups } = state;

    // Build a lookup from tabId -> group for quick access
    const tabToGroup = new Map<string, TabGroup>();
    for (const group of tabGroups) {
      for (const tabId of group.tabIds) {
        tabToGroup.set(tabId, group);
      }
    }

    // Track which groups have already been emitted (by id)
    const emittedGroupIds = new Set<string>();
    // Track which tabs have been consumed (placed into a group entry)
    const consumedTabIds = new Set<string>();

    const layout: TabLayoutItem[] = [];

    for (const tabId of tabOrder) {
      // Skip tabs already consumed by a previously-emitted group
      if (consumedTabIds.has(tabId)) continue;

      const group = tabToGroup.get(tabId);

      if (group && !emittedGroupIds.has(group.id)) {
        // First occurrence of a member of this group.
        // Defensively repair contiguity: gather ALL members from tabOrder
        // (even those appearing later) and cluster them at this position.
        const orderedMembers = tabOrder.filter(id => group.tabIds.includes(id));
        for (const memberId of orderedMembers) {
          consumedTabIds.add(memberId);
        }
        emittedGroupIds.add(group.id);

        layout.push({
          type: 'group',
          group,
          projectIds: orderedMembers,
        });
      } else if (!group) {
        // Ungrouped tab
        layout.push({
          type: 'tab',
          projectId: tabId,
        });
      }
      // If group was already emitted, skip (tab was consumed above)
    }

    return layout;
  },

  getSortableItems: () => {
    const state = get();
    const layout = state.getTabLayout();
    const items: string[] = [];

    for (const entry of layout) {
      if (entry.type === 'group') {
        // Group chip is always represented by its prefixed ID
        items.push(`group:${entry.group.id}`);
        // Only include individual member tab IDs if the group is expanded
        if (!entry.group.collapsed) {
          for (const projectId of entry.projectIds) {
            items.push(projectId);
          }
        }
      } else {
        items.push(entry.projectId);
      }
    }

    return items;
  },

  getVisibleTabs: () => {
    const state = get();
    const layout = state.getTabLayout();
    const visibleIds: string[] = [];

    for (const entry of layout) {
      if (entry.type === 'group') {
        // Only include member tabs if the group is expanded
        if (!entry.group.collapsed) {
          for (const projectId of entry.projectIds) {
            visibleIds.push(projectId);
          }
        }
        // Collapsed group members are skipped entirely for keyboard nav
      } else {
        visibleIds.push(entry.projectId);
      }
    }

    return visibleIds;
  }
}));

/**
 * Save tab state to main process (debounced to avoid excessive IPC calls)
 */
function saveTabStateToMain(): void {
  // Clear any pending save
  if (saveTabStateTimeout) {
    clearTimeout(saveTabStateTimeout);
  }

  // Debounce saves to avoid excessive IPC calls
  saveTabStateTimeout = setTimeout(async () => {
    const store = useProjectStore.getState();
    const tabState = {
      openProjectIds: store.openProjectIds,
      activeProjectId: store.activeProjectId,
      tabOrder: store.tabOrder,
      tabGroups: store.tabGroups
    };
    console.log('[ProjectStore] Saving tab state to main process:', tabState);
    try {
      await window.electronAPI.saveTabState(tabState);
    } catch (err) {
      console.error('[ProjectStore] Failed to save tab state:', err);
    }
  }, 100);
}

/**
 * Load projects from main process
 */
export async function loadProjects(): Promise<void> {
  const store = useProjectStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    // First, load tab state from main process (reliable persistence)
    const tabStateResult = await window.electronAPI.getTabState();
    console.log('[ProjectStore] Loaded tab state from main process:', tabStateResult.data);

    if (tabStateResult.success && tabStateResult.data) {
      useProjectStore.setState({
        openProjectIds: tabStateResult.data.openProjectIds || [],
        activeProjectId: tabStateResult.data.activeProjectId || null,
        tabOrder: tabStateResult.data.tabOrder || [],
        tabGroups: tabStateResult.data.tabGroups || []
      });
    }

    // Then load projects
    const result = await window.electronAPI.getProjects();
    console.log('[ProjectStore] getProjects result:', {
      success: result.success,
      projectCount: result.data?.length,
      projectIds: result.data?.map(p => p.id)
    });

    if (result.success && result.data) {
      store.setProjects(result.data);

      // Get current tab state (may have been loaded from IPC)
      const currentState = useProjectStore.getState();

      // Clean up tab state - remove any project IDs that no longer exist
      const validOpenProjectIds = currentState.openProjectIds.filter(id =>
        result.data?.some((p) => p.id === id) ?? false
      );
      const validTabOrder = currentState.tabOrder.filter(id =>
        result.data?.some((p) => p.id === id) ?? false
      );
      const validActiveProjectId = currentState.activeProjectId &&
        result.data?.some((p) => p.id === currentState.activeProjectId)
        ? currentState.activeProjectId
        : null;

      // Clean up tab groups - remove invalid tab IDs and empty groups
      const validTabGroups = currentState.tabGroups
        .map(g => ({
          ...g,
          tabIds: g.tabIds.filter(id => result.data?.some((p) => p.id === id) ?? false)
        }))
        .filter(g => g.tabIds.length > 0);

      console.log('[ProjectStore] Tab state cleanup:', {
        originalOpenProjectIds: currentState.openProjectIds,
        validOpenProjectIds,
        originalTabOrder: currentState.tabOrder,
        validTabOrder,
        originalActiveProjectId: currentState.activeProjectId,
        validActiveProjectId,
        originalTabGroups: currentState.tabGroups.length,
        validTabGroups: validTabGroups.length
      });

      // Update store with cleaned tab state if needed
      if (validOpenProjectIds.length !== currentState.openProjectIds.length ||
          validTabOrder.length !== currentState.tabOrder.length ||
          validActiveProjectId !== currentState.activeProjectId ||
          validTabGroups.length !== currentState.tabGroups.length) {
        console.log('[ProjectStore] Updating cleaned tab state');
        useProjectStore.setState({
          openProjectIds: validOpenProjectIds,
          tabOrder: validTabOrder,
          activeProjectId: validActiveProjectId,
          tabGroups: validTabGroups
        });
        // Save cleaned state back to main process
        saveTabStateToMain();
      } else {
        console.log('[ProjectStore] Tab state is valid, no cleanup needed');
      }

      // Restore last selected project from localStorage for backward compatibility,
      // or fall back to active project, or first project
      const updatedState = useProjectStore.getState();
      if (!updatedState.selectedProjectId && result.data.length > 0) {
        const lastSelectedId = localStorage.getItem(LAST_SELECTED_PROJECT_KEY);
        const projectExists = lastSelectedId && result.data.some((p) => p.id === lastSelectedId);

        if (projectExists) {
          store.selectProject(lastSelectedId);
        } else if (updatedState.activeProjectId) {
          store.selectProject(updatedState.activeProjectId);
        } else {
          store.selectProject(result.data[0].id);
        }
      }
    } else {
      store.setError(result.error || 'Failed to load projects');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Add a new project
 */
export async function addProject(projectPath: string): Promise<Project | null> {
  const store = useProjectStore.getState();

  try {
    const result = await window.electronAPI.addProject(projectPath);
    if (result.success && result.data) {
      store.addProject(result.data);
      store.selectProject(result.data.id);
      // Also open a tab for the new project
      store.openProjectTab(result.data.id);
      return result.data;
    } else {
      store.setError(result.error || 'Failed to add project');
      return null;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Remove a project
 */
export async function removeProject(projectId: string): Promise<boolean> {
  const store = useProjectStore.getState();

  try {
    const result = await window.electronAPI.removeProject(projectId);
    if (result.success) {
      store.removeProject(projectId);
      // Also close the tab if it's open
      if (store.openProjectIds.includes(projectId)) {
        store.closeProjectTab(projectId);
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Update project settings
 */
export async function updateProjectSettings(
  projectId: string,
  settings: Partial<ProjectSettings>
): Promise<boolean> {
  const store = useProjectStore.getState();

  try {
    const result = await window.electronAPI.updateProjectSettings(
      projectId,
      settings
    );
    if (result.success) {
      const project = store.projects.find((p) => p.id === projectId);
      if (project) {
        // Merge settings properly, handling the case where project.settings might be undefined
        const currentSettings = project.settings || {};
        store.updateProject(projectId, {
          settings: { ...currentSettings, ...settings }
        });
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Rename a project tab. Pass a non-empty string to set a custom name,
 * or undefined / empty / whitespace to clear it back to the default.
 * The name is trimmed and capped at 50 characters.
 */
export async function renameProjectTab(
  projectId: string,
  customTabName: string | undefined
): Promise<boolean> {
  const sanitized = customTabName?.trim().slice(0, 50) || undefined;
  return updateProjectSettings(projectId, { customTabName: sanitized });
}

/**
 * Set or remove a project tab's color tint.
 * Pass a color id (e.g. "red", "blue") to set, or undefined to clear.
 */
export async function setProjectTabColor(
  projectId: string,
  tabColor: string | undefined
): Promise<boolean> {
  return updateProjectSettings(projectId, { tabColor });
}

/**
 * Check auto-claude version status for a project
 */
export async function checkProjectVersion(
  projectId: string
): Promise<AutoBuildVersionInfo | null> {
  try {
    const result = await window.electronAPI.checkProjectVersion(projectId);
    if (result.success && result.data) {
      return result.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Initialize auto-claude in a project
 */
export async function initializeProject(
  projectId: string
): Promise<InitializationResult | null> {
  const store = useProjectStore.getState();

  try {
    console.log('[ProjectStore] initializeProject called for:', projectId);
    const result = await window.electronAPI.initializeProject(projectId);
    console.log('[ProjectStore] IPC result:', result);

    if (result.success && result.data) {
      console.log('[ProjectStore] IPC succeeded, result.data:', result.data);
      // Update the project's autoBuildPath in local state
      if (result.data.success) {
        console.log('[ProjectStore] Updating project autoBuildPath to .auto-claude');
        store.updateProject(projectId, { autoBuildPath: '.auto-claude' });
      } else {
        console.log('[ProjectStore] result.data.success is false, not updating project');
      }
      return result.data;
    }
    console.log('[ProjectStore] IPC failed or no data, setting error');
    store.setError(result.error || 'Failed to initialize project');
    return null;
  } catch (error) {
    console.error('[ProjectStore] Exception during initializeProject:', error);
    store.setError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}
