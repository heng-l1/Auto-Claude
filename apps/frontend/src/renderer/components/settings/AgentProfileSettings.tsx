import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Scale, Zap, Check, Sparkles, ChevronDown, ChevronUp, RotateCcw, Settings2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  DEFAULT_AGENT_PROFILES,
  AVAILABLE_MODELS,
  THINKING_LEVELS,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  ADAPTIVE_THINKING_MODELS,
  PHASE_KEYS
} from '../../../shared/constants';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { SettingsSection } from './SettingsSection';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Switch } from '../ui/switch';
import type { AgentProfile, PhaseModelConfig, PhaseThinkingConfig, PhaseUltrathinkConfig, ModelTypeShort, ThinkingLevel } from '../../../shared/types/settings';

/**
 * Icon mapping for agent profile icons
 */
const iconMap: Record<string, React.ElementType> = {
  Brain,
  Scale,
  Zap,
  Sparkles,
  Settings2
};

/**
 * Agent Profile Settings component
 * Displays preset agent profiles for quick model/thinking level configuration
 * All presets show phase configuration for full customization
 */
export function AgentProfileSettings() {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((state) => state.settings);
  const selectedProfileId = settings.selectedAgentProfile || 'auto';
  const [showPhaseConfig, setShowPhaseConfig] = useState(true);

  // Find the selected profile
  const selectedProfile = useMemo(() =>
    DEFAULT_AGENT_PROFILES.find(p => p.id === selectedProfileId) || DEFAULT_AGENT_PROFILES[0],
    [selectedProfileId]
  );

  // Get profile's default phase config
  const profilePhaseModels = selectedProfile.phaseModels || DEFAULT_PHASE_MODELS;
  const profilePhaseThinking = selectedProfile.phaseThinking || DEFAULT_PHASE_THINKING;

  // Get current phase config from settings (custom) or fall back to profile defaults
  const currentPhaseModels: PhaseModelConfig = settings.customPhaseModels || profilePhaseModels;
  const currentPhaseThinking: PhaseThinkingConfig = settings.customPhaseThinking || profilePhaseThinking;
  const currentPhaseUltrathink: PhaseUltrathinkConfig = settings.customPhaseUltrathink || {};

  /**
   * Check if current config differs from the selected profile's defaults
   */
  const hasCustomConfig = useMemo((): boolean => {
    if (!settings.customPhaseModels && !settings.customPhaseThinking && !settings.customPhaseUltrathink) {
      return false; // No custom settings, using profile defaults
    }
    // Check if any phase ultrathink is enabled (profiles don't have ultrathink defaults)
    const hasUltrathink = settings.customPhaseUltrathink && PHASE_KEYS.some(
      phase => currentPhaseUltrathink[phase]
    );
    return hasUltrathink || PHASE_KEYS.some(
      phase =>
        currentPhaseModels[phase] !== profilePhaseModels[phase] ||
        currentPhaseThinking[phase] !== profilePhaseThinking[phase]
    );
  }, [settings.customPhaseModels, settings.customPhaseThinking, settings.customPhaseUltrathink, currentPhaseModels, currentPhaseThinking, currentPhaseUltrathink, profilePhaseModels, profilePhaseThinking]);

  const handleSelectProfile = async (profileId: string) => {
    const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === profileId);
    if (!profile) return;

    // When selecting a preset, reset to that preset's defaults
    const success = await saveSettings({
      selectedAgentProfile: profileId,
      // Clear custom settings to use profile defaults
      customPhaseModels: undefined,
      customPhaseThinking: undefined,
      customPhaseUltrathink: undefined
    });
    if (!success) {
      console.error('Failed to save agent profile selection');
      return;
    }
  };

  const handlePhaseModelChange = async (phase: keyof PhaseModelConfig, value: ModelTypeShort) => {
    // Save as custom config (deviating from preset)
    const newPhaseModels = { ...currentPhaseModels, [phase]: value };
    await saveSettings({ customPhaseModels: newPhaseModels });
  };

  const handlePhaseThinkingChange = async (phase: keyof PhaseThinkingConfig, value: ThinkingLevel) => {
    // Save as custom config (deviating from preset)
    const newPhaseThinking = { ...currentPhaseThinking, [phase]: value };
    await saveSettings({ customPhaseThinking: newPhaseThinking });
  };

  const handlePhaseUltrathinkChange = async (phase: keyof PhaseUltrathinkConfig, enabled: boolean) => {
    // Save ultrathink toggle for the specific phase
    const newPhaseUltrathink = { ...currentPhaseUltrathink, [phase]: enabled };
    await saveSettings({ customPhaseUltrathink: newPhaseUltrathink });
  };

  const handleResetToProfileDefaults = async () => {
    // Reset to the selected profile's defaults
    await saveSettings({
      customPhaseModels: undefined,
      customPhaseThinking: undefined,
      customPhaseUltrathink: undefined
    });
  };

  /**
   * Get human-readable model label
   */
  const getModelLabel = (modelValue: string): string => {
    const model = AVAILABLE_MODELS.find((m) => m.value === modelValue);
    return model?.label || modelValue;
  };

  /**
   * Get human-readable thinking level label
   */
  const getThinkingLabel = (thinkingValue: string): string => {
    const level = THINKING_LEVELS.find((l) => l.value === thinkingValue);
    return level?.label || thinkingValue;
  };

  /**
   * Render a single profile card
   */
  const renderProfileCard = (profile: AgentProfile) => {
    const isSelected = selectedProfileId === profile.id;
    const isCustomized = isSelected && hasCustomConfig;
    const Icon = iconMap[profile.icon || 'Brain'] || Brain;

    return (
      <button
        key={profile.id}
        onClick={() => handleSelectProfile(profile.id)}
        className={cn(
          'relative w-full rounded-lg border p-4 text-left transition-all duration-200',
          'hover:border-primary/50 hover:shadow-sm',
          isSelected
            ? 'border-primary bg-primary/5'
            : 'border-border bg-card'
        )}
      >
        {/* Selected indicator */}
        {isSelected && (
          <div className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
            <Check className="h-3 w-3 text-primary-foreground" />
          </div>
        )}

        {/* Profile content */}
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-lg shrink-0',
              isSelected ? 'bg-primary/10' : 'bg-muted'
            )}
          >
            <Icon
              className={cn(
                'h-5 w-5',
                isSelected ? 'text-primary' : 'text-muted-foreground'
              )}
            />
          </div>

          <div className="flex-1 min-w-0 pr-6">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm text-foreground">{profile.name}</h3>
              {isCustomized && (
                <span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
                  {t('agentProfile.customized')}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
              {profile.description}
            </p>

            {/* Model and thinking level badges */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {getModelLabel(profile.model)}
              </span>
              <span className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {getThinkingLabel(profile.thinkingLevel)} {t('agentProfile.thinking')}
              </span>
            </div>
          </div>
        </div>
      </button>
    );
  };

  return (
    <SettingsSection
      title={t('agentProfile.title')}
      description={t('agentProfile.sectionDescription')}
    >
      <div className="space-y-4">
        {/* Description */}
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            {t('agentProfile.profilesInfo')}
          </p>
        </div>

        {/* Profile cards - 2 column grid on larger screens */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {DEFAULT_AGENT_PROFILES.map(renderProfileCard)}
        </div>

        {/* Phase Configuration - shown for all profiles */}
        <div className="mt-6 rounded-lg border border-border bg-card">
          {/* Header - Collapsible */}
          <button
            type="button"
            onClick={() => setShowPhaseConfig(!showPhaseConfig)}
            className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/50 transition-colors rounded-t-lg"
          >
            <div>
              <h4 className="font-medium text-sm text-foreground">{t('agentProfile.phaseConfiguration')}</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('agentProfile.phaseConfigurationDescription')}
              </p>
            </div>
            {showPhaseConfig ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {/* Phase Configuration Content */}
          {showPhaseConfig && (
            <div className="border-t border-border p-4 space-y-4">
              {/* Reset button - shown when customized */}
              {hasCustomConfig && (
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleResetToProfileDefaults}
                    className="text-xs h-7"
                  >
                    <RotateCcw className="h-3 w-3 mr-1.5" />
                    {t('agentProfile.resetToProfileDefaults', { profile: selectedProfile.name })}
                  </Button>
                </div>
              )}

              {/* Phase Configuration Grid */}
              <div className="space-y-4">
                {PHASE_KEYS.map((phase) => {
                  const isUltrathink = currentPhaseUltrathink[phase] === true;
                  return (
                    <div key={phase} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium text-foreground">
                          {t(`agentProfile.phases.${phase}.label`)}
                        </Label>
                        <span className="text-xs text-muted-foreground">
                          {t(`agentProfile.phases.${phase}.description`)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {/* Model Select */}
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">{t('agentProfile.model')}</Label>
                          <Select
                            value={currentPhaseModels[phase]}
                            onValueChange={(value) => handlePhaseModelChange(phase, value as ModelTypeShort)}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {AVAILABLE_MODELS.map((m) => (
                                <SelectItem key={m.value} value={m.value}>
                                  {m.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* Thinking Level Select */}
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <Label className="text-xs text-muted-foreground">{t('agentProfile.thinkingLevel')}</Label>
                            {ADAPTIVE_THINKING_MODELS.includes(currentPhaseModels[phase]) && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary cursor-help">
                                    {t('agentProfile.adaptiveThinking.badge')}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs">
                                  <p className="text-xs">{t('agentProfile.adaptiveThinking.tooltip')}</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                          <Select
                            value={currentPhaseThinking[phase]}
                            onValueChange={(value) => handlePhaseThinkingChange(phase, value as ThinkingLevel)}
                            disabled={isUltrathink}
                          >
                            <SelectTrigger className={cn('h-9', isUltrathink && 'opacity-50')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {THINKING_LEVELS.map((level) => (
                                <SelectItem key={level.value} value={level.value}>
                                  {level.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {/* Ultrathink Toggle */}
                      <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-xs text-muted-foreground cursor-help">
                              {t('agentProfile.ultrathink')}
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs">
                            <p className="text-xs">{t('agentProfile.ultrathinkTooltip')}</p>
                          </TooltipContent>
                        </Tooltip>
                        <Switch
                          checked={isUltrathink}
                          onCheckedChange={(checked) => handlePhaseUltrathinkChange(phase, checked)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Info note */}
              <p className="text-[10px] text-muted-foreground mt-4 pt-3 border-t border-border">
                {t('agentProfile.phaseConfigNote')}
              </p>
            </div>
          )}
        </div>

      </div>
    </SettingsSection>
  );
}
