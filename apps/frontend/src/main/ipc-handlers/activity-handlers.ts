/**
 * Activity Center IPC Handlers
 *
 * Handles activity center operations for notification history:
 * - Getting all notifications
 * - Marking notifications as read
 * - Marking all notifications as read
 * - Clearing all notifications
 * - Deleting a single notification
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, ActivityNotification } from '../../shared/types';
import { notificationStore } from '../notification-store';

/**
 * Register activity center IPC handlers
 *
 * @param getMainWindow - Function to get the main BrowserWindow
 */
export function registerActivityHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
  // Get all notifications
  ipcMain.handle(
    IPC_CHANNELS.ACTIVITY_GET_NOTIFICATIONS,
    async (): Promise<IPCResult<ActivityNotification[]>> => {
      try {
        const notifications = notificationStore.getAll();
        return { success: true, data: notifications };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
      }
    }
  );

  // Mark a single notification as read
  ipcMain.handle(
    IPC_CHANNELS.ACTIVITY_MARK_READ,
    async (_, id: string): Promise<IPCResult<ActivityNotification>> => {
      try {
        notificationStore.markRead(id);
        const notifications = notificationStore.getAll();
        const updated = notifications.find((n) => n.id === id);
        return { success: true, data: updated };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
      }
    }
  );

  // Mark all notifications as read
  ipcMain.handle(
    IPC_CHANNELS.ACTIVITY_MARK_ALL_READ,
    async (): Promise<IPCResult> => {
      try {
        notificationStore.markAllRead();
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
      }
    }
  );

  // Clear all notifications
  ipcMain.handle(
    IPC_CHANNELS.ACTIVITY_CLEAR_ALL,
    async (): Promise<IPCResult> => {
      try {
        notificationStore.clearAll();
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
      }
    }
  );

  // Delete a single notification
  ipcMain.handle(
    IPC_CHANNELS.ACTIVITY_DELETE,
    async (_, id: string): Promise<IPCResult> => {
      try {
        notificationStore.deleteNotification(id);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
      }
    }
  );
}
