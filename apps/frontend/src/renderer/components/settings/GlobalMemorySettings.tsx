import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { SettingsSection } from './SettingsSection';
import type { AppSettings } from '../../../shared/types';

interface GlobalMemorySettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Global Memory settings section
 * Allows users to enable/disable cross-project working pattern memory
 */
export function GlobalMemorySettings({ settings, onSettingsChange }: GlobalMemorySettingsProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection
      title={t('globalMemory.title')}
      description={t('globalMemory.description')}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between max-w-md">
          <div className="space-y-1">
            <Label htmlFor="globalMemoryEnabled" className="text-sm font-medium text-foreground">
              {t('globalMemory.enabled')}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t('globalMemory.enabledDescription')}
            </p>
          </div>
          <Switch
            id="globalMemoryEnabled"
            checked={settings.globalMemoryEnabled ?? false}
            onCheckedChange={(checked) => onSettingsChange({ ...settings, globalMemoryEnabled: checked })}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
