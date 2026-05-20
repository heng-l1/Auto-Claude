/**
 * ExtractFindingsConfirmDialog
 *
 * Modal presented after the user clicks "Capture findings to PR review" on a
 * PR-discussion terminal. The Haiku-tier scrollback extractor (running in the
 * main process — see `pr-manual-findings-handlers.ts`) returns an array of
 * candidate findings; this dialog renders a checklist of those candidates so
 * the user can pick which ones to persist. Each row shows the severity,
 * file:line, the candidate's title, and the description text doubling as the
 * "source-quote snippet" — the model is prompted to keep the relevant
 * transcript excerpt inline with the description so the user can verify
 * provenance before committing.
 *
 * Render modes (driven by the `candidates` prop):
 *   - `null` — extraction is still in flight. Renders a spinner with the
 *     "Extracting findings…" copy. Clicking Cancel notifies the parent via
 *     `onCancel` so the parent's AbortController can interrupt the underlying
 *     IPC call.
 *   - `[]` — extractor returned no findings. Renders the empty state
 *     ("No findings detected").
 *   - non-empty array — renders the checklist with every row checked by
 *     default. The "Add (N)" button submits each checked candidate via
 *     `addManualFinding` on the PR review store.
 *
 * The dialog is presentation-only with respect to the extract IPC — the
 * parent owns the AbortController and toggles `open` to dismiss. After a
 * successful Add (N) submission the dialog notifies the parent via
 * `onConfirm(submitted)` and closes itself.
 *
 * Keyboard ergonomics:
 *   - Esc closes the dialog (handled by the Radix Dialog primitive — routed
 *     through `handleCancel` so the in-flight extraction is also aborted).
 *   - Space toggles a focused checkbox row (native Radix Checkbox behaviour).
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { Checkbox } from '../../ui/checkbox';
import { ScrollArea } from '../../ui/scroll-area';
import { cn } from '../../../lib/utils';
import { SEVERITY_CONFIG, type SeverityGroup } from '../constants/severity-config';
import { usePRReviewStore } from '../../../stores/github/pr-review-store';
import type { ManualPRReviewFinding } from '@shared/types/pr-review-comments';

interface ExtractFindingsConfirmDialogProps {
  /** Controls modal visibility. */
  open: boolean;
  /** Notified when the dialog wants to open/close (e.g. on Esc). */
  onOpenChange: (open: boolean) => void;
  /** Active project — required so `addManualFinding` knows where to write. */
  projectId: string;
  /** PR number for the add IPC calls. */
  prNumber: number;
  /**
   * Extracted candidate findings.
   *   - `null`  → extraction in flight; dialog shows the spinner.
   *   - `[]`    → extractor returned nothing; dialog shows the empty state.
   *   - array   → checklist of candidates ready for selection.
   *
   * Each candidate is a fully-validated `ManualPRReviewFinding` produced by
   * the Haiku extractor with `source: 'terminal'` already set. The temporary
   * `id` field is local to this dialog (used as the React key and the
   * selection-state key) — the IPC handler generates a fresh id on persist.
   */
  candidates: ManualPRReviewFinding[] | null;
  /**
   * Called when the user clicks Cancel (or dismisses via Esc / overlay
   * click). Parents wire this to abort the in-flight extract IPC via the
   * AbortController and to close the dialog.
   */
  onCancel: () => void;
  /**
   * Optional notification fired after the user clicks "Add (N)" and the
   * subset has been persisted. Receives the candidates that were submitted
   * (post-persist, so the caller can record telemetry / kick off a refresh).
   */
  onConfirm?: (submitted: ManualPRReviewFinding[]) => void;
}

export function ExtractFindingsConfirmDialog({
  open,
  onOpenChange,
  projectId,
  prNumber,
  candidates,
  onCancel,
  onConfirm,
}: ExtractFindingsConfirmDialogProps) {
  const { t } = useTranslation('common');
  const fieldIdPrefix = useId();

  // Selection state — keyed by each candidate's temporary id. When new
  // candidates arrive (`candidates` ref changes) we default every row to
  // checked so the user's "happy path" (accept everything) is a single click.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const addManualFinding = usePRReviewStore((s) => s.addManualFinding);

  // Re-seed the selection set whenever the candidates change while the dialog
  // is open. Closing the dialog leaves the selection in place — but we reset
  // on the next open so a stale set never leaks across two distinct extract
  // runs.
  useEffect(() => {
    if (!open) {
      setSubmitError(null);
      return;
    }
    if (Array.isArray(candidates)) {
      setChecked(new Set(candidates.map((c) => c.id)));
    } else {
      // Loading state — clear any previous selection so a fast re-extract
      // doesn't briefly show stale checks before the new candidates arrive.
      setChecked(new Set());
    }
    setSubmitError(null);
  }, [open, candidates]);

  const handleToggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectedCandidates = useMemo<ManualPRReviewFinding[]>(() => {
    if (!Array.isArray(candidates)) return [];
    return candidates.filter((c) => checked.has(c.id));
  }, [candidates, checked]);

  /**
   * Cancel button / Esc / overlay click → notify the parent so the
   * AbortController can interrupt the in-flight extract IPC. We block cancel
   * mid-submit so the user can't accidentally orphan an in-flight Add (N)
   * write — the submit promise will resolve quickly enough that the gating
   * is essentially invisible.
   */
  const handleCancel = useCallback(() => {
    if (isSubmitting) return;
    onCancel();
  }, [isSubmitting, onCancel]);

  /**
   * Submit every checked candidate through `addManualFinding`. The store
   * action runs serially under a per-PR mutex on the main side, so wrapping
   * the calls in `Promise.all` here just hands the queue to the main process
   * — no client-side serialization needed. The dialog closes itself on
   * full success; on partial failure it surfaces a banner and keeps the
   * dialog open so the user can re-try the unsaved subset.
   */
  const handleSubmit = useCallback(async () => {
    if (isSubmitting || selectedCandidates.length === 0) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const results = await Promise.all(
        selectedCandidates.map((candidate) =>
          addManualFinding(projectId, prNumber, {
            severity: candidate.severity,
            category: candidate.category,
            title: candidate.title,
            description: candidate.description,
            file: candidate.file,
            line: candidate.line,
            endLine: candidate.endLine,
            suggestedFix: candidate.suggestedFix,
            fixable: candidate.fixable,
            // Preserve terminal provenance on the persisted record. The
            // handler defaults `source` to `'manual'` when the caller omits
            // it; we explicitly set `'terminal'` because the candidates came
            // from the Haiku extractor over the terminal scrollback.
            source: candidate.source ?? 'terminal',
            authoredBy: candidate.authoredBy ?? 'terminal-extraction',
          }),
        ),
      );
      const succeeded = results.filter(
        (r): r is ManualPRReviewFinding => r != null,
      );
      if (succeeded.length < selectedCandidates.length) {
        setSubmitError(
          t('prReview.extractDialog.partialFailure', {
            defaultValue:
              'Some findings could not be saved. The successful ones were added; please re-try the rest.',
          }),
        );
        // If at least one persisted, still notify and close — the failed
        // ones stay checked so the user can re-submit on the next round.
        if (succeeded.length === 0) {
          return;
        }
      }
      onConfirm?.(succeeded);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : t('prReview.extractDialog.submitFailed', {
              defaultValue: 'Failed to save findings. Please try again.',
            }),
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isSubmitting,
    selectedCandidates,
    addManualFinding,
    projectId,
    prNumber,
    onConfirm,
    onOpenChange,
    t,
  ]);

  const isLoading = candidates === null;
  const isEmpty = Array.isArray(candidates) && candidates.length === 0;
  const hasCandidates = Array.isArray(candidates) && candidates.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          handleCancel();
        } else {
          onOpenChange(true);
        }
      }}
    >
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {t('prReview.extractDialog.title', {
              defaultValue: 'Capture Findings from Terminal',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('prReview.extractDialog.description', {
              defaultValue:
                'Review the candidates extracted from the terminal transcript and choose which to add to the PR review.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-hidden py-2">
          {isLoading && (
            <output
              aria-live="polite"
              className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground"
            >
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">
                {t('prReview.extractDialog.extracting', {
                  defaultValue: 'Extracting findings…',
                })}
              </span>
            </output>
          )}

          {isEmpty && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <span className="text-sm">
                {t('prReview.extractDialog.noFindings', {
                  defaultValue: 'No findings detected in this conversation',
                })}
              </span>
            </div>
          )}

          {hasCandidates && (
            <ScrollArea className="h-full max-h-[440px] pr-2">
              <ul className="space-y-2 p-1">
                {candidates.map((candidate) => {
                  const isChecked = checked.has(candidate.id);
                  const config =
                    SEVERITY_CONFIG[candidate.severity as SeverityGroup] ??
                    SEVERITY_CONFIG.medium;
                  const Icon = config.icon;
                  const rowId = `${fieldIdPrefix}-${candidate.id}`;
                  const fileLineLabel =
                    candidate.file +
                    (candidate.line > 0 ? `:${candidate.line}` : '') +
                    (candidate.endLine && candidate.endLine > candidate.line
                      ? `-${candidate.endLine}`
                      : '');
                  return (
                    <li
                      key={candidate.id}
                      className={cn(
                        'flex items-start gap-3 rounded-lg border bg-card p-3',
                        'transition-colors',
                        isChecked
                          ? 'border-primary/40 ring-1 ring-primary/30'
                          : 'border-border',
                      )}
                    >
                      <Checkbox
                        id={rowId}
                        checked={isChecked}
                        onCheckedChange={() => handleToggle(candidate.id)}
                        className="mt-1"
                        disabled={isSubmitting}
                        aria-label={candidate.title}
                      />
                      <label
                        htmlFor={rowId}
                        className="flex-1 min-w-0 cursor-pointer space-y-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-xs shrink-0 border-current',
                              config.color,
                              config.bgColor,
                            )}
                          >
                            <Icon className="h-3 w-3 mr-1" />
                            {t(config.labelKey, {
                              defaultValue: candidate.severity,
                            })}
                          </Badge>
                          {candidate.file && (
                            <Badge
                              variant="outline"
                              className="text-xs shrink-0 font-mono truncate max-w-full"
                              title={fileLineLabel}
                            >
                              {fileLineLabel}
                            </Badge>
                          )}
                        </div>
                        <div className="text-sm font-medium text-foreground break-words">
                          {candidate.title}
                        </div>
                        {/*
                         * Source-quote snippet for provenance. The Haiku
                         * extractor is prompted to keep the relevant
                         * transcript excerpt inside the description so the
                         * user can verify the candidate wasn't fabricated.
                         * The blockquote styling makes the excerpt visually
                         * distinct from the title without burying it.
                         */}
                        {candidate.description && (
                          <div className="text-xs text-muted-foreground border-l-2 border-border pl-2 line-clamp-3 whitespace-pre-wrap break-words">
                            {candidate.description}
                          </div>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}

          {submitError && (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {submitError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            {t('prReview.extractDialog.cancel', { defaultValue: 'Cancel' })}
          </Button>
          {hasCandidates && (
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={selectedCandidates.length === 0 || isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('prReview.extractDialog.saving', {
                    defaultValue: 'Saving…',
                  })}
                </>
              ) : (
                t('prReview.extractDialog.addN', {
                  defaultValue: 'Add ({{count}})',
                  count: selectedCandidates.length,
                })
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
