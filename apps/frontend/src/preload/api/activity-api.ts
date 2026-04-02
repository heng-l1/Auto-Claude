import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, ActivityNotification } from '../../shared/types';

export interface ActivityAPI {
  getNotifications: () => Promise<IPCResult<ActivityNotification[]>>;
  markRead: (id: string) => Promise<IPCResult>;
  markAllRead: () => Promise<IPCResult>;
  clearAll: () => Promise<IPCResult>;
  deleteNotification: (id: string) => Promise<IPCResult>;
  onActivityNotification: (callback: (notification: ActivityNotification) => void) => () => void;
}

export const createActivityAPI = (): ActivityAPI => ({
  getNotifications: (): Promise<IPCResult<ActivityNotification[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_GET_NOTIFICATIONS),

  markRead: (id: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_MARK_READ, id),

  markAllRead: (): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_MARK_ALL_READ),

  clearAll: (): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_CLEAR_ALL),

  deleteNotification: (id: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_DELETE, id),

  onActivityNotification: (
    callback: (notification: ActivityNotification) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      notification: ActivityNotification
    ): void => {
      callback(notification);
    };
    ipcRenderer.on(IPC_CHANNELS.ACTIVITY_NOTIFICATION, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ACTIVITY_NOTIFICATION, handler);
    };
  }
});
