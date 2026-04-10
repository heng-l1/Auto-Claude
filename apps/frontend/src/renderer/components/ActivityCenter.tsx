import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bell,
  CheckCircle2,
  XCircle,
  Eye,
  GitPullRequest,
  TerminalSquare,
  Inbox
} from 'lucide-react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import {
  Popover,
  PopoverTrigger,
  PopoverContent
} from './ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from './ui/tooltip';
import { cn, formatRelativeTime } from '../lib/utils';
import {
  useActivityStore,
  markNotificationRead,
  markAllNotificationsRead,
  clearAllNotifications
} from '../stores/activity-store';
import { useProjectStore } from '../stores/project-store';
import type { SidebarView } from './Sidebar';
import type { ActivityNotificationType } from '../../shared/types';

interface ActivityCenterProps {
  onViewChange: (view: SidebarView) => void;
  onNavigateToProject?: (projectId: string, view: SidebarView) => void;
  onSelectTerminal?: (terminalId: string) => void;
  isCollapsed: boolean;
}

const notificationIcons: Record<ActivityNotificationType, React.ElementType> = {
  'task-complete': CheckCircle2,
  'task-failed': XCircle,
  'review-needed': Eye,
  'pr-review-complete': GitPullRequest,
  'claude-session-complete': TerminalSquare
};

const notificationIconColors: Record<ActivityNotificationType, string> = {
  'task-complete': 'text-green-500',
  'task-failed': 'text-red-500',
  'review-needed': 'text-yellow-500',
  'pr-review-complete': 'text-blue-500',
  'claude-session-complete': 'text-purple-500'
};

function getNavigationTarget(type: ActivityNotificationType): SidebarView {
  switch (type) {
    case 'task-complete':
    case 'task-failed':
    case 'review-needed':
      return 'kanban';
    case 'pr-review-complete':
      return 'github-prs';
    case 'claude-session-complete':
      return 'terminals';
  }
}

export function ActivityCenter({ onViewChange, onNavigateToProject, onSelectTerminal, isCollapsed }: ActivityCenterProps) {
  const { t } = useTranslation(['common']);
  const [open, setOpen] = useState(false);

  const notifications = useActivityStore((state) => state.notifications);
  const unreadCount = useActivityStore((state) => state.unreadCount);

  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);

  const getProjectName = (projectId?: string): string | undefined => {
    if (!projectId) return undefined;
    return projects.find((p) => p.id === projectId)?.name;
  };

  const handleNotificationClick = (id: string, type: ActivityNotificationType, projectId?: string, terminalId?: string) => {
    markNotificationRead(id);
    const targetView = getNavigationTarget(type);

    // If notification belongs to a different project, navigate to that project + view
    if (projectId && projectId !== activeProjectId && onNavigateToProject) {
      onNavigateToProject(projectId, targetView);
    } else {
      onViewChange(targetView);
    }

    // Focus the specific terminal when clicking a claude-session-complete notification
    if (type === 'claude-session-complete' && terminalId && onSelectTerminal) {
      onSelectTerminal(terminalId);
    }

    setOpen(false);
  };

  const handleMarkAllRead = () => {
    markAllNotificationsRead();
  };

  const handleClearAll = () => {
    clearAllNotifications();
  };

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'relative h-8 w-8 shrink-0',
        isCollapsed && 'mx-auto'
      )}
    >
      <Bell className="h-4 w-4" />
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        </span>
      )}
    </Button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {isCollapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {triggerButton}
            </TooltipTrigger>
            <TooltipContent side="right">
              <span>{t('common:activityCenter.title')}</span>
            </TooltipContent>
          </Tooltip>
        ) : (
          triggerButton
        )}
      </PopoverTrigger>

      <PopoverContent
        className="w-[360px] p-0"
        align="start"
        sideOffset={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">
            {t('common:activityCenter.title')}
          </h3>
          <div className="flex items-center gap-1">
            {notifications.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={handleMarkAllRead}
                  disabled={unreadCount === 0}
                >
                  {t('common:activityCenter.markAllRead')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={handleClearAll}
                >
                  {t('common:activityCenter.clearAll')}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Notification list */}
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <Inbox className="h-8 w-8" />
            <p className="text-sm">{t('common:activityCenter.noNotifications')}</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[400px]">
            <div className="flex flex-col">
              {notifications.map((notification) => {
                const Icon = notificationIcons[notification.type];
                const iconColor = notificationIconColors[notification.type];
                const projectName = getProjectName(notification.projectId);

                return (
                  <button
                    key={notification.id}
                    type="button"
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent',
                      !notification.isRead && 'bg-accent/50'
                    )}
                    onClick={() =>
                      handleNotificationClick(notification.id, notification.type, notification.projectId, notification.terminalId)
                    }
                  >
                    <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconColor)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p
                          className={cn(
                            'truncate text-sm',
                            !notification.isRead ? 'font-medium' : 'text-muted-foreground'
                          )}
                        >
                          {notification.title}
                        </p>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatRelativeTime(new Date(notification.createdAt))}
                        </span>
                      </div>
                      {projectName && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground/70">
                          {projectName}
                        </p>
                      )}
                      {notification.body && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {notification.body}
                        </p>
                      )}
                    </div>
                    {!notification.isRead && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500" />
                    )}
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
