import { useEffect } from 'react';
import { useActivityStore } from '../stores/activity-store';

/**
 * Hook that subscribes to ACTIVITY_NOTIFICATION IPC events from the main process
 * and pushes new notifications into the Zustand activity store.
 *
 * This hook should be called once at the app level (e.g., in App.tsx) to ensure
 * activity notifications are captured regardless of which view is active.
 */
export function useActivityListeners(): void {
  useEffect(() => {
    const cleanup = window.electronAPI.onActivityNotification((notification) => {
      useActivityStore.getState().addNotification(notification);
    });

    return cleanup;
  }, []);
}
