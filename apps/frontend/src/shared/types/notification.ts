/**
 * Activity notification types for the Activity Center
 */

export type ActivityNotificationType =
  | 'task-complete'
  | 'task-failed'
  | 'review-needed'
  | 'pr-review-complete';

export interface ActivityNotification {
  id: string;
  type: ActivityNotificationType;
  title: string;
  body: string;
  projectId?: string;
  taskId?: string;
  prNumber?: number;
  isRead: boolean;
  createdAt: string;  // ISO 8601 string
}
