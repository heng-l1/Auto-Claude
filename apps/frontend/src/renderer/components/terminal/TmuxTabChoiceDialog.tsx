import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { saveSettings } from '../../stores/settings-store';

interface TmuxTabChoiceDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** Callback when user chooses to create a new tmux window */
  onChooseTmuxWindow: () => void;
  /** Callback when user chooses to use the default profile */
  onChooseDefaultProfile: () => void;
  /** Whether a new terminal can be created (false when at terminal limit) */
  canCreateNewTerminal: boolean;
}

export function TmuxTabChoiceDialog({
  open,
  onOpenChange,
  onChooseTmuxWindow,
  onChooseDefaultProfile,
  canCreateNewTerminal,
}: TmuxTabChoiceDialogProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const [rememberChoice, setRememberChoice] = useState(false);

  // Reset rememberChoice when dialog opens
  useEffect(() => {
    if (open) {
      setRememberChoice(false);
    }
  }, [open]);

  const handleChooseTmuxWindow = () => {
    if (rememberChoice) {
      saveSettings({ tmuxTabPreference: 'tmux-window' });
    }
    onChooseTmuxWindow();
    onOpenChange(false);
  };

  const handleChooseDefaultProfile = () => {
    if (rememberChoice) {
      saveSettings({ tmuxTabPreference: 'default-profile' });
    }
    onChooseDefaultProfile();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>
            {t('terminal:tmuxTabChoice.title')}
          </DialogTitle>
          <DialogDescription>
            {t('terminal:tmuxTabChoice.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center space-x-2 py-4">
          <Checkbox
            id="remember-choice"
            checked={rememberChoice}
            onCheckedChange={(checked) => setRememberChoice(checked === true)}
          />
          <Label htmlFor="remember-choice" className="cursor-pointer text-sm">
            {t('terminal:tmuxTabChoice.rememberChoice')}
          </Label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:buttons.cancel')}
          </Button>
          <Button
            onClick={handleChooseDefaultProfile}
            disabled={!canCreateNewTerminal}
            variant="secondary"
          >
            {t('terminal:tmuxTabChoice.useDefaultProfile')}
          </Button>
          <Button onClick={handleChooseTmuxWindow}>
            {t('terminal:tmuxTabChoice.newTmuxTab')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
