import { app } from 'electron';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { ActivityNotification, ActivityNotificationType } from '../shared/types';
import { writeFileAtomicSync } from './utils/atomic-file';

interface NotificationOptions {
  projectId?: string;
  taskId?: string;
  prNumber?: number;
}

interface StoreData {
  notifications: ActivityNotification[];
}

const MAX_NOTIFICATIONS = 200;

/**
 * Persistent storage for activity notifications.
 * Stores notification history to disk so it survives app restarts.
 */
export class NotificationStore {
  private storePath: string;
  private data: StoreData;

  constructor() {
    // Store in app's userData directory
    const userDataPath = app.getPath('userData');
    const storeDir = path.join(userDataPath, 'store');

    // Ensure directory exists
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true });
    }

    this.storePath = path.join(storeDir, 'notifications.json');
    this.data = this.load();
  }

  /**
   * Load store from disk
   */
  private load(): StoreData {
    if (existsSync(this.storePath)) {
      try {
        const content = readFileSync(this.storePath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return { notifications: [] };
      }
    }
    return { notifications: [] };
  }

  /**
   * Save store to disk
   */
  private save(): void {
    writeFileAtomicSync(this.storePath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Add a new notification.
   * Auto-prunes to MAX_NOTIFICATIONS entries, dropping the oldest by createdAt.
   */
  addNotification(
    type: ActivityNotificationType,
    title: string,
    body: string,
    opts?: NotificationOptions
  ): ActivityNotification {
    const notification: ActivityNotification = {
      id: uuidv4(),
      type,
      title,
      body,
      projectId: opts?.projectId,
      taskId: opts?.taskId,
      prNumber: opts?.prNumber,
      isRead: false,
      createdAt: new Date().toISOString(),
    };

    this.data.notifications.push(notification);

    // Auto-prune: keep only the newest MAX_NOTIFICATIONS entries
    if (this.data.notifications.length > MAX_NOTIFICATIONS) {
      this.data.notifications.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      this.data.notifications = this.data.notifications.slice(-MAX_NOTIFICATIONS);
    }

    this.save();
    return notification;
  }

  /**
   * Get all notifications
   */
  getAll(): ActivityNotification[] {
    return this.data.notifications;
  }

  /**
   * Mark a single notification as read
   */
  markRead(id: string): void {
    const notification = this.data.notifications.find((n) => n.id === id);
    if (notification) {
      notification.isRead = true;
      this.save();
    }
  }

  /**
   * Mark all notifications as read
   */
  markAllRead(): void {
    for (const notification of this.data.notifications) {
      notification.isRead = true;
    }
    this.save();
  }

  /**
   * Clear all notifications
   */
  clearAll(): void {
    this.data.notifications = [];
    this.save();
  }

  /**
   * Delete a single notification by ID
   */
  deleteNotification(id: string): void {
    this.data.notifications = this.data.notifications.filter((n) => n.id !== id);
    this.save();
  }
}

// Singleton instance
export const notificationStore = new NotificationStore();
