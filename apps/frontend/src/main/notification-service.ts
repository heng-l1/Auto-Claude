import { Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { projectStore } from './project-store';
import { notificationStore } from './notification-store';
import { safeSendToRenderer } from './ipc-handlers/utils';
import { IPC_CHANNELS } from '../shared/constants';

export type NotificationType = 'task-complete' | 'task-failed' | 'review-needed' | 'pr-review-complete' | 'claude-session-complete';

interface NotificationOptions {
  title: string;
  body: string;
  projectId?: string;
  taskId?: string;
  prNumber?: number;
  terminalId?: string;
}

/**
 * Service for sending system notifications with optional sound
 */
class NotificationService {
  private mainWindow: (() => BrowserWindow | null) | null = null;

  /**
   * Initialize the notification service with the main window getter
   */
  initialize(getMainWindow: () => BrowserWindow | null): void {
    this.mainWindow = getMainWindow;
  }

  /**
   * Send a notification for task completion
   */
  notifyTaskComplete(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-complete', {
      title: 'Task Complete',
      body: `"${taskTitle}" has completed and is ready for review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for task failure
   */
  notifyTaskFailed(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-failed', {
      title: 'Task Failed',
      body: `"${taskTitle}" encountered an error`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for review needed
   */
  notifyReviewNeeded(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('review-needed', {
      title: 'Review Needed',
      body: `"${taskTitle}" is ready for your review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for Claude terminal session completion
   */
  notifyClaudeSessionComplete(terminalName: string, projectId: string, terminalId: string): void {
    this.sendNotification('claude-session-complete', {
      title: 'Claude Session Complete',
      body: `"${terminalName}" has finished its session`,
      projectId,
      terminalId
    });
  }

  /**
   * Send a notification for PR review completion
   */
  notifyPRReviewComplete(prNumber: number, projectId: string): void {
    this.sendNotification('pr-review-complete', {
      title: 'PR Review Complete',
      body: `PR #${prNumber} review is complete and ready to post`,
      projectId,
      prNumber
    });
  }

  /**
   * Send a system notification with optional sound
   */
  private sendNotification(type: NotificationType, options: NotificationOptions): void {
    // Persist to activity notification store (always, regardless of OS notification settings)
    const addedNotification = notificationStore.addNotification(type, options.title, options.body, {
      projectId: options.projectId,
      taskId: options.taskId,
      prNumber: options.prNumber,
      terminalId: options.terminalId
    });

    // Push activity notification to renderer
    if (this.mainWindow) {
      safeSendToRenderer(this.mainWindow, IPC_CHANNELS.ACTIVITY_NOTIFICATION, addedNotification);
    }

    // Get notification settings
    const settings = this.getNotificationSettings(options.projectId);

    // Check if this notification type is enabled
    if (!this.isNotificationEnabled(type, settings)) {
      return;
    }

    // Create and show the notification
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: !settings.sound // Let the OS handle sound if enabled
      });

      // Focus window when notification is clicked
      notification.on('click', () => {
        const window = this.mainWindow?.();
        if (window) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.focus();
        }
      });

      notification.show();
    }

    // Play sound if enabled (system beep)
    if (settings.sound) {
      this.playNotificationSound();
    }
  }

  /**
   * Play a notification sound
   */
  private playNotificationSound(): void {
    // Use system beep - works across all platforms
    shell.beep();
  }

  /**
   * Get notification settings for a project or fall back to defaults
   */
  private getNotificationSettings(projectId?: string): {
    onTaskComplete: boolean;
    onTaskFailed: boolean;
    onReviewNeeded: boolean;
    onPRReviewComplete: boolean;
    onClaudeSessionComplete: boolean;
    sound: boolean;
  } {
    // Try to get project-specific settings
    if (projectId) {
      const projects = projectStore.getProjects();
      const project = projects.find(p => p.id === projectId);
      if (project?.settings?.notifications) {
        return project.settings.notifications;
      }
    }

    // Fall back to defaults
    return {
      onTaskComplete: true,
      onTaskFailed: true,
      onReviewNeeded: true,
      onPRReviewComplete: true,
      onClaudeSessionComplete: true,
      sound: false
    };
  }

  /**
   * Check if a notification type is enabled in settings
   */
  private isNotificationEnabled(
    type: NotificationType,
    settings: {
      onTaskComplete: boolean;
      onTaskFailed: boolean;
      onReviewNeeded: boolean;
      onPRReviewComplete: boolean;
      onClaudeSessionComplete: boolean;
      sound: boolean;
    }
  ): boolean {
    switch (type) {
      case 'task-complete':
        return settings.onTaskComplete;
      case 'task-failed':
        return settings.onTaskFailed;
      case 'review-needed':
        return settings.onReviewNeeded;
      case 'pr-review-complete':
        return settings.onPRReviewComplete;
      case 'claude-session-complete':
        return settings.onClaudeSessionComplete;
      default:
        return false;
    }
  }
}

// Export singleton instance
export const notificationService = new NotificationService();