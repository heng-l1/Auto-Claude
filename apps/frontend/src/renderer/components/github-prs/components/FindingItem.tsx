/**
 * FindingItem - Individual finding display with checkbox and details
 *
 * Renders both AI-generated and manually-authored findings. Manual findings
 * (source === 'manual' | 'terminal') get a source badge plus pencil + trash
 * icons that surface on row hover/focus. AI findings (source === 'ai' or
 * undefined) remain immutable — no badge, no inline actions — preserving
 * the spec's contract that AI findings can only be selected and posted, not
 * edited or deleted in place.
 *
 * The edit and delete affordances require `projectId` and `pr` props so the
 * dialog seeding and `deleteManualFinding` IPC call can address the right PR.
 * When those props are omitted (e.g. legacy callers that haven't yet been
 * threaded through), the row gracefully degrades to badge-only — the source
 * label still surfaces but the inline actions are suppressed.
 */

import { useCallback, useState } from 'react';
import { CheckCircle, Pencil, Trash2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../ui/badge';
import { Checkbox } from '../../ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import { cn } from '../../../lib/utils';
import { getCategoryIcon } from '../constants/severity-config';
import { usePRReviewStore } from '../../../stores/github/pr-review-store';
import { AddManualFindingDialog } from './AddManualFindingDialog';
import type { PRReviewFinding } from '@shared/types/pr-review-comments';
import type { PRData } from '../../../../preload/api/modules/github-api';

interface FindingItemProps {
  finding: PRReviewFinding;
  selected: boolean;
  posted?: boolean;
  disputed?: boolean;
  onToggle: () => void;
  /**
   * Active project id — required to enable pencil/trash inline actions on
   * manual findings (the store actions are keyed by projectId). When missing,
   * the row degrades to read-only (badge only, no inline actions).
   */
  projectId?: string;
  /**
   * The parent PR record — used to seed the file autocomplete in the edit
   * dialog and to derive prNumber for the delete IPC call. When missing, the
   * row degrades to read-only.
   */
  pr?: PRData;
}

// Helper to translate category names
function getCategoryTranslationKey(category: string): string {
  // Map category values to translation keys
  const categoryMap: Record<string, string> = {
    'security': 'prReview.category.security',
    'logic': 'prReview.category.logic',
    'quality': 'prReview.category.quality',
    'performance': 'prReview.category.performance',
    'style': 'prReview.category.style',
    'documentation': 'prReview.category.documentation',
    'testing': 'prReview.category.testing',
    'other': 'prReview.category.other',
  };
  return categoryMap[category.toLowerCase()] || category;
}

export function FindingItem({
  finding,
  selected,
  posted = false,
  disputed = false,
  onToggle,
  projectId,
  pr,
}: FindingItemProps) {
  const { t } = useTranslation('common');
  const CategoryIcon = getCategoryIcon(finding.category);

  // Get translated category name (falls back to original if translation not found)
  const categoryKey = getCategoryTranslationKey(finding.category);
  const categoryLabel = t(categoryKey, { defaultValue: finding.category });

  // Treat findings without a source (legacy/back-compat AI records) as AI so
  // they remain immutable. Manual + terminal-authored findings flip into the
  // editable branch below.
  const isManual = finding.source != null && finding.source !== 'ai';

  // Inline actions require both projectId (for the store IPC) and pr (for the
  // file autocomplete inside the edit dialog). When either is missing the row
  // still renders the source badge — only the pencil/trash icons are gated.
  const canEditOrDelete = isManual && projectId != null && pr != null;

  // Local UI state for the per-row edit dialog and delete-confirmation flow.
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const deleteManualFinding = usePRReviewStore((s) => s.deleteManualFinding);

  const handleDelete = useCallback(async () => {
    if (!projectId || !pr) return;
    setIsDeleting(true);
    try {
      await deleteManualFinding(projectId, pr.number, finding.id);
      setDeleteConfirmOpen(false);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteManualFinding, projectId, pr, finding.id]);

  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-background p-3 space-y-2 transition-colors",
        selected && !posted && !disputed && "ring-2 ring-primary/50",
        selected && disputed && "ring-2 ring-purple-500/50",
        (posted || (disputed && !selected)) && "opacity-60"
      )}
    >
      {/* Inline edit/delete actions for manual findings (hover-revealed) */}
      {canEditOrDelete && (
        <div
          className={cn(
            "absolute top-2 right-2 flex items-center gap-1",
            "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
            "transition-opacity"
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditDialogOpen(true);
            }}
            className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t('prReview.findings.editManual', { defaultValue: 'Edit finding' })}
            aria-label={t('prReview.findings.editManual', { defaultValue: 'Edit finding' })}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteConfirmOpen(true);
            }}
            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t('prReview.findings.deleteManual', { defaultValue: 'Delete finding' })}
            aria-label={t('prReview.findings.deleteManual', { defaultValue: 'Delete finding' })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Finding Header */}
      <div className="flex items-start gap-3">
        {posted ? (
          <CheckCircle className="h-4 w-4 mt-0.5 text-success shrink-0" />
        ) : (
          <Checkbox
            id={finding.id}
            checked={selected}
            onCheckedChange={onToggle}
            className="mt-0.5"
          />
        )}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs shrink-0">
              <CategoryIcon className="h-3 w-3 mr-1" />
              {categoryLabel}
            </Badge>
            {/* Source badge — only rendered for non-AI findings */}
            {finding.source === 'manual' && (
              <Badge
                variant="outline"
                className="text-xs shrink-0 bg-blue-500/10 text-blue-500 border-blue-500/30"
              >
                {t('prReview.findings.source.manual', { defaultValue: 'Manual' })}
              </Badge>
            )}
            {finding.source === 'terminal' && (
              <Badge
                variant="outline"
                className="text-xs shrink-0 bg-amber-500/10 text-amber-500 border-amber-500/30"
              >
                {t('prReview.findings.source.terminal', { defaultValue: 'From terminal' })}
              </Badge>
            )}
            {posted && (
              <Badge variant="outline" className="text-xs shrink-0 text-success border-success/50">
                {t('prReview.posted')}
              </Badge>
            )}
            {disputed && (
              <Badge variant="outline" className="text-xs shrink-0 bg-purple-500/10 text-purple-500 border-purple-500/30">
                {t('prReview.disputed')}
              </Badge>
            )}
            {finding.crossValidated && finding.sourceAgents && finding.sourceAgents.length > 1 && (
              <Badge variant="outline" className="text-xs shrink-0 bg-green-500/10 text-green-500 border-green-500/30">
                {t('prReview.crossValidatedBy', { count: finding.sourceAgents.length })}
              </Badge>
            )}
            <span className="font-medium text-sm break-words">
              {finding.title}
            </span>
          </div>
          <p className="text-sm text-muted-foreground break-words">
            {finding.description}
          </p>
          {disputed && finding.validationExplanation && (
            <p className="text-xs text-purple-500/80 italic break-words">
              {finding.validationExplanation}
            </p>
          )}
          <div className="text-xs text-muted-foreground">
            <code className="bg-muted px-1 py-0.5 rounded break-all">
              {finding.file}:{finding.line}
              {finding.endLine && finding.endLine !== finding.line && `-${finding.endLine}`}
            </code>
          </div>
        </div>
      </div>

      {/* Suggested Fix */}
      {finding.suggestedFix && (
        <div className="ml-7 text-xs">
          <span className="text-muted-foreground font-medium">{t('prReview.suggestedFix')}</span>
          <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto max-w-full whitespace-pre-wrap break-words">
            {finding.suggestedFix}
          </pre>
        </div>
      )}

      {/* Edit dialog — reuses the same AddManualFindingDialog used for
          "+ Add Finding", passing editingId so it routes to
          updateManualFinding. Mounting it conditionally keeps the dialog
          out of the DOM until the user clicks the pencil for the first
          time on this row. */}
      {canEditOrDelete && pr && projectId && (
        <AddManualFindingDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          projectId={projectId}
          pr={pr}
          editingId={finding.id}
          initialValues={finding}
        />
      )}

      {/* Delete confirmation — uses the prReview.findings.deleteConfirm i18n
          key for the body, with a defaultValue fallback in case the
          translation hasn't shipped yet. */}
      {canEditOrDelete && (
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('prReview.findings.deleteManual', { defaultValue: 'Delete finding' })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('prReview.findings.deleteConfirm', {
                  defaultValue:
                    'Delete this manual finding? This action cannot be undone.',
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>
                {t('prReview.cancel', { defaultValue: 'Cancel' })}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleDelete();
                }}
                disabled={isDeleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('prReview.findings.deleting', { defaultValue: 'Deleting…' })}
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('prReview.findings.deleteManual', { defaultValue: 'Delete finding' })}
                  </>
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
