import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  ClipboardList,
  Monitor,
  Globe,
  Brain,
  Info,
  Plus,
  Pencil,
  Trash2,
  Terminal,
} from 'lucide-react';
import { Switch } from '../ui/switch';
import { Button } from '../ui/button';
import { SettingsSection } from './SettingsSection';
import { CustomMcpDialog } from '../CustomMcpDialog';
import type { AppSettings, CustomMcpServer, GlobalMcpServers } from '../../../shared/types';

interface GlobalMcpSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Global MCP Settings section
 * Configures default MCP servers that apply to all projects unless overridden.
 * Built-in server toggles + custom server management.
 */
export function GlobalMcpSettings({ settings, onSettingsChange }: GlobalMcpSettingsProps) {
  const { t } = useTranslation('settings');
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false);
  const [editingCustomServer, setEditingCustomServer] = useState<CustomMcpServer | null>(null);

  const globalMcp: GlobalMcpServers = settings.globalMcpServers ?? {};
  const customServers: CustomMcpServer[] = settings.globalCustomMcpServers ?? [];

  const updateToggle = (key: keyof GlobalMcpServers, checked: boolean) => {
    onSettingsChange({
      ...settings,
      globalMcpServers: {
        ...globalMcp,
        [key]: checked,
      },
    });
  };

  const handleSaveCustomServer = (server: CustomMcpServer) => {
    const existingIndex = customServers.findIndex((s) => s.id === server.id);
    const updated =
      existingIndex >= 0
        ? customServers.map((s, i) => (i === existingIndex ? server : s))
        : [...customServers, server];

    onSettingsChange({
      ...settings,
      globalCustomMcpServers: updated,
    });
  };

  const handleDeleteCustomServer = (id: string) => {
    onSettingsChange({
      ...settings,
      globalCustomMcpServers: customServers.filter((s) => s.id !== id),
    });
  };

  return (
    <SettingsSection
      title={t('globalMcp.title')}
      description={t('globalMcp.description')}
    >
      <div className="space-y-6">
        {/* Built-in Servers */}
        <div>
          <h4 className="text-sm font-medium text-foreground mb-3">
            {t('globalMcp.builtInServers')}
          </h4>

          <div className="space-y-0">
            {/* Context7 */}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="flex items-center gap-3">
                <Search className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">{t('mcp.servers.context7.name')}</span>
                  <p className="text-xs text-muted-foreground">{t('mcp.servers.context7.description')}</p>
                </div>
              </div>
              <Switch
                checked={globalMcp.context7Enabled !== false}
                onCheckedChange={(checked) => updateToggle('context7Enabled', checked)}
              />
            </div>

            {/* Linear */}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="flex items-center gap-3">
                <ClipboardList className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">{t('mcp.servers.linear.name')}</span>
                  <p className="text-xs text-muted-foreground">{t('mcp.servers.linear.description')}</p>
                </div>
              </div>
              <Switch
                checked={globalMcp.linearMcpEnabled !== false}
                onCheckedChange={(checked) => updateToggle('linearMcpEnabled', checked)}
              />
            </div>

            {/* Electron */}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="flex items-center gap-3">
                <Monitor className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">{t('mcp.servers.electron.name')}</span>
                  <p className="text-xs text-muted-foreground">{t('mcp.servers.electron.description')}</p>
                </div>
              </div>
              <Switch
                checked={globalMcp.electronEnabled === true}
                onCheckedChange={(checked) => updateToggle('electronEnabled', checked)}
              />
            </div>

            {/* Puppeteer */}
            <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <div className="flex items-center gap-3">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">{t('mcp.servers.puppeteer.name')}</span>
                  <p className="text-xs text-muted-foreground">{t('mcp.servers.puppeteer.description')}</p>
                </div>
              </div>
              <Switch
                checked={globalMcp.puppeteerEnabled === true}
                onCheckedChange={(checked) => updateToggle('puppeteerEnabled', checked)}
              />
            </div>
          </div>

          {/* Graphiti note */}
          <div className="flex items-start gap-2 mt-4 p-3 bg-muted/50 rounded-lg">
            <Brain className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted-foreground">{t('globalMcp.graphitiNote')}</p>
          </div>
        </div>

        {/* Custom Servers */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Terminal className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                {t('globalMcp.customServersSection')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => { setEditingCustomServer(null); setShowCustomMcpDialog(true); }}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
            >
              <Plus className="h-3 w-3" />
              {t('globalMcp.addCustomServer')}
            </button>
          </div>

          {customServers.length > 0 ? (
            <div className="space-y-2">
              {customServers.map((server) => (
                <div
                  key={server.id}
                  className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-lg group"
                >
                  <div className="flex items-center gap-3">
                    {server.type === 'command' ? (
                      <Terminal className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Globe className="h-4 w-4 text-muted-foreground" />
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{server.name}</span>
                      <p className="text-xs text-muted-foreground truncate">
                        {server.type === 'command'
                          ? `${server.command} ${server.args?.join(' ') || ''}`
                          : server.url}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setEditingCustomServer(server); setShowCustomMcpDialog(true); }}
                      className="h-7 w-7 p-0"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteCustomServer(server.id)}
                      className="h-7 w-7 p-0 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-3">
              {t('globalMcp.noCustomServers')}
            </p>
          )}
        </div>

        {/* Per-project overrides info note */}
        <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-xs text-muted-foreground">{t('globalMcp.infoNote')}</p>
        </div>
      </div>

      {/* Custom MCP Server Dialog */}
      <CustomMcpDialog
        open={showCustomMcpDialog}
        onOpenChange={setShowCustomMcpDialog}
        server={editingCustomServer}
        existingIds={customServers.map((s) => s.id)}
        onSave={handleSaveCustomServer}
      />
    </SettingsSection>
  );
}
