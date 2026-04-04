import { create } from 'zustand';
import type { ActivityNotification } from '../../shared/types';

interface ActivityState {
  notifications: ActivityNotification[];
  unreadCount: number;
  isLoading: boolean;

  // Actions
  setNotifications: (notifications: ActivityNotification[]) => void;
  addNotification: (notification: ActivityNotification) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  setLoading: (isLoading: boolean) => void;
}

function computeUnreadCount(notifications: ActivityNotification[]): number {
  return notifications.filter((n) => !n.isRead).length;
}

export const useActivityStore = create<ActivityState>((set) => ({
  notifications: [],
  unreadCount: 0,
  isLoading: false,

  setNotifications: (notifications) =>
    set({
      notifications,
      unreadCount: computeUnreadCount(notifications)
    }),

  addNotification: (notification) =>
    set((state) => {
      const notifications = [notification, ...state.notifications];
      return {
        notifications,
        unreadCount: computeUnreadCount(notifications)
      };
    }),

  markRead: (id) =>
    set((state) => {
      const notifications = state.notifications.map((n) =>
        n.id === id ? { ...n, isRead: true } : n
      );
      return {
        notifications,
        unreadCount: computeUnreadCount(notifications)
      };
    }),

  markAllRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, isRead: true })),
      unreadCount: 0
    })),

  clearAll: () =>
    set({
      notifications: [],
      unreadCount: 0
    }),

  setLoading: (isLoading) => set({ isLoading })
}));

/**
 * Load notifications from main process
 */
export async function loadNotifications(): Promise<void> {
  const store = useActivityStore.getState();
  store.setLoading(true);

  try {
    const result = await window.electronAPI.getNotifications();
    if (result.success && result.data) {
      store.setNotifications(result.data);
    }
  } catch {
    // Silently handle — notifications are non-critical
  } finally {
    store.setLoading(false);
  }
}

/**
 * Mark a single notification as read via IPC and update store
 */
export async function markNotificationRead(id: string): Promise<void> {
  const store = useActivityStore.getState();
  // Optimistic update
  store.markRead(id);

  try {
    await window.electronAPI.markRead(id);
  } catch {
    // Revert on failure by reloading from main process
    await loadNotifications();
  }
}

/**
 * Mark all notifications as read via IPC and update store
 */
export async function markAllNotificationsRead(): Promise<void> {
  const store = useActivityStore.getState();
  // Optimistic update
  store.markAllRead();

  try {
    await window.electronAPI.markAllRead();
  } catch {
    // Revert on failure by reloading from main process
    await loadNotifications();
  }
}

/**
 * Clear all notifications via IPC and update store
 */
export async function clearAllNotifications(): Promise<void> {
  const store = useActivityStore.getState();
  // Optimistic update
  store.clearAll();

  try {
    await window.electronAPI.clearAll();
  } catch {
    // Revert on failure by reloading from main process
    await loadNotifications();
  }
}

/**
 * Delete a single notification via IPC and update store
 */
export async function deleteNotification(id: string): Promise<void> {
  const store = useActivityStore.getState();
  // Optimistic update — remove from local state
  const notifications = store.notifications.filter((n) => n.id !== id);
  store.setNotifications(notifications);

  try {
    await window.electronAPI.deleteNotification(id);
  } catch {
    // Revert on failure by reloading from main process
    await loadNotifications();
  }
}
