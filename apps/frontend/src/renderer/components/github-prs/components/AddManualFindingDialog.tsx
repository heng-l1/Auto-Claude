/**
 * AddManualFindingDialog
 *
 * Modal used by the PR review surface to author and edit "manual" findings —
 * the human (or terminal Claude) authored cousins of AI-generated review
 * findings. The dialog is reused for both Add and Edit by passing
 * `initialValues` (the existing finding's mutable fields) and an optional
 * `editingId` (the immutable finding id that drives the `updateManualFinding`
 * store action). When `editingId` is omitted, a fresh finding is created via
 * `addManualFinding`.
 *
 * Default view exposes the minimum 5 required fields (severity, title, file,
 * line, description). A "More details" toggle reveals optional metadata
 * (category, endLine, suggestedFix). Severity defaults to `medium` and
 * category defaults to `quality`, matching the spec.
 *
 * Keyboard ergonomics:
 *   - Enter on inputs advances focus to the next field (textareas keep their
 *     native newline behaviour)
 *   - Cmd/Ctrl+Enter submits from anywhere inside the form
 *   - Esc closes the dialog (handled by the Radix Dialog primitive)
 *
 * File names are sourced from `pr.files` (the PR's changed files). The input
 * supports free-text — the autocomplete is a hint only because manual
 * findings frequently anchor at lines that aren't in the diff and the user
 * may want to type a path that's not in the changed-file list.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Textarea } from '../../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select';
import { Popover, PopoverContent, PopoverAnchor } from '../../ui/popover';
import { ScrollArea } from '../../ui/scroll-area';
import { cn } from '../../../lib/utils';
import { SEVERITY_CONFIG, SEVERITY_ORDER, type SeverityGroup } from '../constants/severity-config';
import { usePRReviewStore } from '../../../stores/github/pr-review-store';
import type { PRData } from '../../../../preload/api/modules/github-api';
import type { ManualPRReviewFinding, PRReviewFinding } from '@shared/types/pr-review-comments';

/**
 * Category enum mirrors `PRReviewFindingSchema.category`. The order matches
 * the spec's preferred user-facing ordering (quality is the default so it
 * leads the list).
 */
const CATEGORY_VALUES = [
  'quality',
  'security',
  'performance',
  'style',
  'test',
  'docs',
  'pattern',
] as const;
type CategoryValue = (typeof CATEGORY_VALUES)[number];

/**
 * Shape of the form state — a subset of `PRReviewFinding`'s mutable fields.
 * Immutable audit-trail fields (id, source, authoredAt, authoredBy) live on
 * the backing record and never flow through the form.
 */
interface FormState {
  severity: SeverityGroup;
  title: string;
  file: string;
  line: string; // string while editing; coerced to number on submit
  description: string;
  category: CategoryValue;
  endLine: string;
  suggestedFix: string;
}

const EMPTY_FORM: FormState = {
  severity: 'medium',
  title: '',
  file: '',
  line: '',
  description: '',
  category: 'quality',
  endLine: '',
  suggestedFix: '',
};

/**
 * Coerce a (possibly already-typed) PRReviewFinding into the string-backed
 * form state. Used when seeding the dialog for edit or when pre-filling from
 * a "Promote to Finding" action.
 */
function toFormState(initial: Partial<PRReviewFinding> | undefined): FormState {
  if (!initial) return { ...EMPTY_FORM };
  const severity = (initial.severity ?? EMPTY_FORM.severity) as SeverityGroup;
  const category = ((CATEGORY_VALUES as readonly string[]).includes(initial.category ?? '')
    ? (initial.category as CategoryValue)
    : EMPTY_FORM.category);
  return {
    severity,
    title: initial.title ?? '',
    file: initial.file ?? '',
    line: typeof initial.line === 'number' ? String(initial.line) : '',
    description: initial.description ?? '',
    category,
    endLine: typeof initial.endLine === 'number' ? String(initial.endLine) : '',
    suggestedFix: initial.suggestedFix ?? '',
  };
}

/**
 * Build the payload that goes to `addManualFinding` / `updateManualFinding`.
 * The store-side action layers in immutable fields (id, source, authoredAt,
 * authoredBy) for new findings; for updates the handler drops any immutable
 * field from the patch silently.
 */
function buildPayload(form: FormState): Partial<ManualPRReviewFinding> {
  const lineNum = Number.parseInt(form.line, 10);
  const endLineNum = Number.parseInt(form.endLine, 10);
  const payload: Partial<ManualPRReviewFinding> = {
    severity: form.severity,
    category: form.category,
    title: form.title.trim(),
    description: form.description.trim(),
    file: form.file.trim(),
    line: Number.isFinite(lineNum) ? lineNum : 0,
    fixable: false,
  };
  if (Number.isFinite(endLineNum) && endLineNum > 0) {
    payload.endLine = endLineNum;
  }
  const fix = form.suggestedFix.trim();
  if (fix.length > 0) {
    payload.suggestedFix = fix;
  }
  return payload;
}

interface AddManualFindingDialogProps {
  /** Controls modal visibility. */
  open: boolean;
  /** Notified when the dialog wants to open/close. */
  onOpenChange: (open: boolean) => void;
  /** Active project — required so the IPC handler knows where to write. */
  projectId: string;
  /** PR record — drives the file autocomplete suggestions. */
  pr: PRData;
  /**
   * When set, the dialog operates in "edit" mode: the form is seeded with
   * `initialValues` and submitting calls `updateManualFinding(editingId, ...)`.
   * When omitted, the dialog is in "add" mode and submission calls
   * `addManualFinding(...)`.
   */
  editingId?: string;
  /**
   * Optional pre-fill for the form. Used both for edit (full finding) and
   * for actions like "Promote to Finding" that only set a subset (e.g.
   * description from the reviewer notes textarea).
   */
  initialValues?: Partial<PRReviewFinding>;
  /** Optional callback fired after a successful add or update. */
  onSubmitted?: (finding: ManualPRReviewFinding | null) => void;
}

export function AddManualFindingDialog({
  open,
  onOpenChange,
  projectId,
  pr,
  editingId,
  initialValues,
  onSubmitted,
}: AddManualFindingDialogProps) {
  const { t } = useTranslation('common');
  const fieldIdPrefix = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lineRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // Track suggestion popover open state separately from focus to avoid
  // re-opening it when the user explicitly Tabs away.
  const [fileSuggestionsOpen, setFileSuggestionsOpen] = useState(false);

  const [form, setForm] = useState<FormState>(() => toFormState(initialValues));
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isEdit = Boolean(editingId);
  const addManualFinding = usePRReviewStore((s) => s.addManualFinding);
  const updateManualFinding = usePRReviewStore((s) => s.updateManualFinding);

  // Seed the form whenever the dialog opens — so opening a fresh dialog
  // always reflects the latest `initialValues` (which can change e.g. when
  // the user clicks the pencil icon on a different row).
  useEffect(() => {
    if (open) {
      setForm(toFormState(initialValues));
      // Expand "More details" automatically when editing a finding that
      // already has values in the advanced fields, so the user sees the data.
      const hasAdvanced =
        Boolean(initialValues?.suggestedFix) ||
        (typeof initialValues?.endLine === 'number' && initialValues.endLine > 0) ||
        (typeof initialValues?.category === 'string' && initialValues.category !== EMPTY_FORM.category);
      setShowMoreDetails(hasAdvanced);
      setSubmitError(null);
      // Autofocus title (Radix Dialog handles the initial focus delegation —
      // pointing at the title ref via autoFocus is more deterministic across
      // browsers than relying on tabindex order alone).
      setTimeout(() => titleRef.current?.focus(), 0);
    }
  }, [open, initialValues]);

  // Required-field validation gates the submit button.
  const lineNum = Number.parseInt(form.line, 10);
  const endLineNum = Number.parseInt(form.endLine, 10);
  const isLineValid = Number.isFinite(lineNum) && lineNum >= 0;
  const isEndLineValid = form.endLine.trim().length === 0 || (Number.isFinite(endLineNum) && endLineNum >= 0);
  const isFormValid =
    form.title.trim().length > 0 &&
    form.file.trim().length > 0 &&
    form.description.trim().length > 0 &&
    isLineValid &&
    isEndLineValid;

  const fileSuggestions = useMemo(() => {
    const search = form.file.trim().toLowerCase();
    const paths = (pr.files ?? []).map((f) => f.path);
    if (!search) return paths.slice(0, 20);
    return paths
      .filter((p) => p.toLowerCase().includes(search))
      .slice(0, 20);
  }, [pr.files, form.file]);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    onOpenChange(false);
  }, [isSubmitting, onOpenChange]);

  const handleSubmit = useCallback(async () => {
    if (!isFormValid || isSubmitting) return;
    const payload = buildPayload(form);
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      let result: ManualPRReviewFinding | null;
      if (isEdit && editingId) {
        result = await updateManualFinding(projectId, pr.number, editingId, payload);
      } else {
        result = await addManualFinding(projectId, pr.number, payload);
      }
      if (!result) {
        setSubmitError(
          t('prReview.addFindingDialog.submitFailed', {
            defaultValue: 'Failed to save finding. Please try again.',
          })
        );
        return;
      }
      onSubmitted?.(result);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : t('prReview.addFindingDialog.submitFailed', {
              defaultValue: 'Failed to save finding. Please try again.',
            })
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isFormValid,
    isSubmitting,
    form,
    isEdit,
    editingId,
    updateManualFinding,
    projectId,
    pr.number,
    addManualFinding,
    onSubmitted,
    onOpenChange,
    t,
  ]);

  /**
   * Capture Cmd/Ctrl+Enter anywhere inside the form to submit. Native form
   * `onSubmit` would only handle the default Enter, which we deliberately
   * repurpose for focus advancement on single-line inputs.
   */
  const handleFormKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLFormElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  /**
   * Single-line inputs: Enter advances focus to the next logical field
   * instead of submitting. Cmd/Ctrl+Enter still bubbles up to the form-level
   * handler. Textareas are excluded from this — Enter there inserts a
   * newline as users expect.
   */
  const advanceFocusOnEnter = (nextRef: React.RefObject<HTMLElement | null>) =>
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        nextRef.current?.focus();
      }
    };

  const dialogTitle = isEdit
    ? t('prReview.addFindingDialog.editTitle', { defaultValue: 'Edit finding' })
    : t('prReview.addFindingDialog.title', { defaultValue: 'Add manual finding' });
  const dialogDescription = isEdit
    ? t('prReview.addFindingDialog.editDescription', {
        defaultValue: 'Update the details for this manually authored finding.',
      })
    : t('prReview.addFindingDialog.description', {
        defaultValue:
          'Author a finding that will be included alongside AI findings when posting the review.',
      });

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: form-level keydown captures Cmd/Ctrl+Enter from any focused field — this is the standard React keyboard-shortcut pattern */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          onKeyDown={handleFormKeyDown}
          className="space-y-5 py-2"
        >
          {/* Severity chips */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {t('prReview.addFindingDialog.severity', { defaultValue: 'Severity' })}{' '}
              <span className="text-destructive">*</span>
            </Label>
            <div role="radiogroup" aria-label="Severity" className="flex flex-wrap gap-2">
              {SEVERITY_ORDER.map((sev) => {
                const config = SEVERITY_CONFIG[sev];
                const Icon = config.icon;
                const isActive = form.severity === sev;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: chip-style radio with icon needs a button + role="radio"; native input[type="radio"] cannot host the inline icon + label without significant style surgery
                  <button
                    key={sev}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => setForm((f) => ({ ...f, severity: sev }))}
                    disabled={isSubmitting}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium',
                      'transition-colors duration-150',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      isActive
                        ? cn(config.bgColor, config.color, 'border-current')
                        : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t(config.labelKey, { defaultValue: sev })}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title */}
          <div className="space-y-2">
            <Label
              htmlFor={`${fieldIdPrefix}-title`}
              className="text-sm font-medium text-foreground"
            >
              {t('prReview.addFindingDialog.titleField', { defaultValue: 'Title' })}{' '}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${fieldIdPrefix}-title`}
              ref={titleRef}
              autoFocus
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              onKeyDown={advanceFocusOnEnter(fileRef)}
              placeholder={t('prReview.addFindingDialog.titlePlaceholder', {
                defaultValue: 'One-line summary of the finding',
              })}
              disabled={isSubmitting}
              maxLength={500}
              aria-required="true"
            />
          </div>

          {/* File with autocomplete */}
          <div className="space-y-2">
            <Label
              htmlFor={`${fieldIdPrefix}-file`}
              className="text-sm font-medium text-foreground"
            >
              {t('prReview.addFindingDialog.file', { defaultValue: 'File' })}{' '}
              <span className="text-destructive">*</span>
            </Label>
            <Popover open={fileSuggestionsOpen && fileSuggestions.length > 0} onOpenChange={setFileSuggestionsOpen}>
              <PopoverAnchor asChild>
                <Input
                  id={`${fieldIdPrefix}-file`}
                  ref={fileRef}
                  value={form.file}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, file: e.target.value }));
                    setFileSuggestionsOpen(true);
                  }}
                  onFocus={() => setFileSuggestionsOpen(true)}
                  onBlur={() => {
                    // Delay so a click on a suggestion can register before
                    // the popover closes.
                    setTimeout(() => setFileSuggestionsOpen(false), 120);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setFileSuggestionsOpen(false);
                      return;
                    }
                    if (
                      e.key === 'Enter' &&
                      !e.metaKey &&
                      !e.ctrlKey &&
                      !e.shiftKey
                    ) {
                      e.preventDefault();
                      setFileSuggestionsOpen(false);
                      lineRef.current?.focus();
                    }
                  }}
                  placeholder={t('prReview.addFindingDialog.filePlaceholder', {
                    defaultValue: 'src/example/file.ts',
                  })}
                  disabled={isSubmitting}
                  autoComplete="off"
                  aria-required="true"
                  aria-autocomplete="list"
                  aria-expanded={fileSuggestionsOpen}
                />
              </PopoverAnchor>
              <PopoverContent
                align="start"
                sideOffset={4}
                onOpenAutoFocus={(e) => {
                  // Keep focus in the input so the user can keep typing.
                  e.preventDefault();
                }}
                className="w-[var(--radix-popover-trigger-width)] p-0"
              >
                <ScrollArea className="max-h-[240px]">
                  <div className="p-1" role="listbox">
                    {fileSuggestions.map((path) => (
                      <button
                        key={path}
                        type="button"
                        role="option"
                        aria-selected={form.file === path}
                        onMouseDown={(e) => {
                          // Prevent input blur so the click handler runs.
                          e.preventDefault();
                        }}
                        onClick={() => {
                          setForm((f) => ({ ...f, file: path }));
                          setFileSuggestionsOpen(false);
                          lineRef.current?.focus();
                        }}
                        className={cn(
                          'block w-full truncate rounded px-2 py-1.5 text-left text-xs',
                          'hover:bg-accent hover:text-accent-foreground',
                          form.file === path && 'bg-accent text-accent-foreground'
                        )}
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>
            <p className="text-xs text-muted-foreground">
              {t('prReview.addFindingDialog.fileHint', {
                defaultValue: 'Pick a file from this PR or type any path.',
              })}
            </p>
          </div>

          {/* Line */}
          <div className="space-y-2">
            <Label
              htmlFor={`${fieldIdPrefix}-line`}
              className="text-sm font-medium text-foreground"
            >
              {t('prReview.addFindingDialog.line', { defaultValue: 'Line' })}{' '}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${fieldIdPrefix}-line`}
              ref={lineRef}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={form.line}
              onChange={(e) => setForm((f) => ({ ...f, line: e.target.value }))}
              onKeyDown={advanceFocusOnEnter(descriptionRef)}
              placeholder="0"
              disabled={isSubmitting}
              aria-required="true"
            />
            <p className="text-xs text-muted-foreground">
              {t('prReview.addFindingDialog.lineHint', {
                defaultValue:
                  'Use 0 for file-level notes. The finding posts as inline only when this line is in the diff.',
              })}
            </p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label
              htmlFor={`${fieldIdPrefix}-description`}
              className="text-sm font-medium text-foreground"
            >
              {t('prReview.addFindingDialog.descriptionField', {
                defaultValue: 'Description',
              })}{' '}
              <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id={`${fieldIdPrefix}-description`}
              ref={descriptionRef}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t('prReview.addFindingDialog.descriptionPlaceholder', {
                defaultValue:
                  'Explain the issue and (optionally) how to address it. Markdown is supported.',
              })}
              rows={4}
              disabled={isSubmitting}
              aria-required="true"
            />
          </div>

          {/* More details toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowMoreDetails((v) => !v)}
              disabled={isSubmitting}
              className={cn(
                'text-xs font-medium text-primary hover:underline',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
              aria-expanded={showMoreDetails}
            >
              {showMoreDetails
                ? t('prReview.addFindingDialog.lessDetails', { defaultValue: '− Less details' })
                : t('prReview.addFindingDialog.moreDetails', { defaultValue: '+ More details' })}
            </button>
          </div>

          {showMoreDetails && (
            <div className="space-y-5 rounded-lg border border-border bg-muted/30 p-4">
              {/* Category */}
              <div className="space-y-2">
                <Label
                  htmlFor={`${fieldIdPrefix}-category`}
                  className="text-sm font-medium text-foreground"
                >
                  {t('prReview.addFindingDialog.category', { defaultValue: 'Category' })}
                </Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm((f) => ({ ...f, category: v as CategoryValue }))}
                  disabled={isSubmitting}
                >
                  <SelectTrigger id={`${fieldIdPrefix}-category`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_VALUES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`prReview.category.${value}`, { defaultValue: value })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* endLine */}
              <div className="space-y-2">
                <Label
                  htmlFor={`${fieldIdPrefix}-endLine`}
                  className="text-sm font-medium text-foreground"
                >
                  {t('prReview.addFindingDialog.endLine', { defaultValue: 'End line' })}
                </Label>
                <Input
                  id={`${fieldIdPrefix}-endLine`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={form.endLine}
                  onChange={(e) => setForm((f) => ({ ...f, endLine: e.target.value }))}
                  placeholder={t('prReview.addFindingDialog.endLinePlaceholder', {
                    defaultValue: 'Leave blank for single-line',
                  })}
                  disabled={isSubmitting}
                />
                <p className="text-xs text-muted-foreground">
                  {t('prReview.addFindingDialog.endLineHint', {
                    defaultValue:
                      'When both line and end line are in the diff, the comment posts as a multi-line range.',
                  })}
                </p>
              </div>

              {/* suggestedFix */}
              <div className="space-y-2">
                <Label
                  htmlFor={`${fieldIdPrefix}-suggestedFix`}
                  className="text-sm font-medium text-foreground"
                >
                  {t('prReview.addFindingDialog.suggestedFix', {
                    defaultValue: 'Suggested fix',
                  })}
                </Label>
                <Textarea
                  id={`${fieldIdPrefix}-suggestedFix`}
                  value={form.suggestedFix}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, suggestedFix: e.target.value }))
                  }
                  placeholder={t('prReview.addFindingDialog.suggestedFixPlaceholder', {
                    defaultValue: 'Optional code snippet showing the suggested fix',
                  })}
                  rows={5}
                  spellCheck={false}
                  disabled={isSubmitting}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {submitError}
            </div>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            {t('prReview.addFindingDialog.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!isFormValid || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('prReview.addFindingDialog.saving', { defaultValue: 'Saving…' })}
              </>
            ) : isEdit ? (
              t('prReview.addFindingDialog.save', { defaultValue: 'Save changes' })
            ) : (
              t('prReview.addFindingDialog.submit', { defaultValue: 'Add finding' })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
