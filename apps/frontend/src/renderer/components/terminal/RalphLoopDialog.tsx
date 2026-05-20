import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Repeat } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

/**
 * Arguments accepted by the /ralph-loop:ralph-loop slash command builder.
 *
 * The dialog normalizes whitespace (newline collapse + trim) before calling
 * onSubmit, so buildRalphLoopCommand assumes a single-line prompt.
 */
export interface RalphLoopCommandArgs {
  prompt: string;
  maxIterations?: number;
  completionPromise?: string;
}

/**
 * Wraps a value in double quotes and escapes the four characters that retain
 * shell meaning inside "..." in bash: `"`, `\`, `$`, and backtick.
 *
 * We intentionally avoid single-quote escaping because bash cannot escape a
 * literal `'` inside a `'...'` string.
 */
function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Builds a single-line `/ralph-loop:ralph-loop` slash command from the dialog's form
 * inputs. Every user-supplied string is shell-quoted because Claude Code
 * forwards $ARGUMENTS to bash without re-quoting.
 *
 * Gating rules:
 * - maxIterations: included only when finite and > 0, then `Math.floor`'d.
 * - completionPromise: included only when its trimmed value is non-empty.
 */
export function buildRalphLoopCommand({
  prompt,
  maxIterations,
  completionPromise,
}: RalphLoopCommandArgs): string {
  const parts = ['/ralph-loop:ralph-loop', shellQuote(prompt)];

  if (
    typeof maxIterations === 'number' &&
    Number.isFinite(maxIterations) &&
    maxIterations > 0
  ) {
    parts.push('--max-iterations', String(Math.floor(maxIterations)));
  }

  if (completionPromise && completionPromise.trim().length > 0) {
    parts.push('--completion-promise', shellQuote(completionPromise));
  }

  return parts.join(' ');
}

interface RalphLoopDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** Callback invoked when the user clicks Run. Receives the normalized form values. */
  onSubmit: (args: RalphLoopCommandArgs) => void;
}

export function RalphLoopDialog({
  open,
  onOpenChange,
  onSubmit,
}: RalphLoopDialogProps) {
  const { t } = useTranslation(['dialogs', 'common']);
  const [prompt, setPrompt] = useState('');
  const [maxIterations, setMaxIterations] = useState('');
  const [completionPromise, setCompletionPromise] = useState('');

  const resetForm = useCallback(() => {
    setPrompt('');
    setMaxIterations('');
    setCompletionPromise('');
  }, []);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        resetForm();
      }
      onOpenChange(newOpen);
    },
    [onOpenChange, resetForm]
  );

  const trimmedPrompt = prompt.trim();
  const isRunDisabled = trimmedPrompt === '';

  const handleRun = useCallback(() => {
    if (isRunDisabled) return;

    // Normalize newlines: trim outer whitespace and collapse any internal
    // newline (plus surrounding whitespace) into a single space so the
    // resulting slash command is a single line.
    const normalizedPrompt = trimmedPrompt.replace(/\s*\n\s*/g, ' ');

    const parsedMaxIterations = maxIterations.trim()
      ? Number(maxIterations)
      : undefined;

    onSubmit({
      prompt: normalizedPrompt,
      maxIterations: parsedMaxIterations,
      completionPromise: completionPromise,
    });

    resetForm();
    onOpenChange(false);
  }, [
    completionPromise,
    isRunDisabled,
    maxIterations,
    onOpenChange,
    onSubmit,
    resetForm,
    trimmedPrompt,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            {t('dialogs:ralphLoop.title')}
          </DialogTitle>
          <DialogDescription>
            {t('dialogs:ralphLoop.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Prompt (required) */}
          <div className="space-y-2">
            <Label htmlFor="ralph-loop-prompt">
              {t('dialogs:ralphLoop.promptLabel')}
            </Label>
            <Textarea
              id="ralph-loop-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('dialogs:ralphLoop.promptPlaceholder')}
              rows={4}
              autoFocus
            />
          </div>

          {/* Max iterations (optional) */}
          <div className="space-y-2">
            <Label htmlFor="ralph-loop-max-iterations" className="flex items-center gap-2">
              {t('dialogs:ralphLoop.maxIterationsLabel')}
              <span className="text-muted-foreground text-xs">
                ({t('common:labels.optional')})
              </span>
            </Label>
            <Input
              id="ralph-loop-max-iterations"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              placeholder={t('dialogs:ralphLoop.maxIterationsPlaceholder')}
            />
          </div>

          {/* Completion promise (optional) */}
          <div className="space-y-2">
            <Label htmlFor="ralph-loop-completion-promise" className="flex items-center gap-2">
              {t('dialogs:ralphLoop.completionPromiseLabel')}
              <span className="text-muted-foreground text-xs">
                ({t('common:labels.optional')})
              </span>
            </Label>
            <Input
              id="ralph-loop-completion-promise"
              type="text"
              value={completionPromise}
              onChange={(e) => setCompletionPromise(e.target.value)}
              placeholder={t('dialogs:ralphLoop.completionPromisePlaceholder')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t('common:buttons.cancel')}
          </Button>
          <Button onClick={handleRun} disabled={isRunDisabled}>
            {t('dialogs:ralphLoop.runButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RalphLoopDialog;
