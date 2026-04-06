/**
 * App Update IPC Handlers
 *
 * Handles IPC communication for Electron app auto-updates.
 * Provides handlers for checking update availability and getting the current version.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, AppUpdateInfo } from '../../shared/types';
import {
  checkForUpdates,
  getCurrentVersion,
} from '../app-updater';

/**
 * Register all app-update-related IPC handlers
 */
export function registerAppUpdateHandlers(): void {
  console.warn('[IPC] Registering app update handlers');

  // ============================================
  // App Update Operations
  // ============================================

  /**
   * APP_UPDATE_CHECK: Manually check for updates
   * Returns update availability and version information
   */
  ipcMain.handle(
    IPC_CHANNELS.APP_UPDATE_CHECK,
    async (): Promise<IPCResult<AppUpdateInfo | null>> => {
      try {
        const result = await checkForUpdates();
        return { success: true, data: result };
      } catch (error) {
        console.error('[app-update-handlers] Check for updates failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check for updates'
        };
      }
    }
  );

  /**
   * APP_UPDATE_GET_VERSION: Get current app version
   * Returns the current application version
   */
  ipcMain.handle(
    IPC_CHANNELS.APP_UPDATE_GET_VERSION,
    async (): Promise<string> => {
      try {
        const version = getCurrentVersion();
        return version;
      } catch (error) {
        console.error('[app-update-handlers] Get version failed:', error);
        throw error;
      }
    }
  );

  console.warn('[IPC] App update handlers registered successfully');
}
