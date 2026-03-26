import { useState, useEffect, useCallback } from 'react';
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
  Code,
  CheckCircle2,
  Circle,
  AlertCircle,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Switch } from '../ui/switch';
import { Button } from '../ui/button';
import { SettingsSection } from './SettingsSection';
import { CustomMcpDialog } from '../CustomMcpDialog';
import { AgentMcpCard } from './AgentMcpCard';
import { AGENT_CONFIGS, CATEGORIES } from '../../../shared/constants/agent-mcp';
import {
  useResolvedAgentSettings,
  resolveAgentSettings,
} from '../../hooks/useResolvedAgentSettings';
import { AVAILABLE_MODELS, THINKING_LEVELS } from '../../../shared/constants/models';
import type {
  AppSettings,
  CustomMcpServer,
  GlobalMcpServers,
  McpHealthCheckResult,
  ModelTypeShort,
  ThinkingLevel,
} from '../../../shared/types';
import type { AgentMcpOverride } from '../../../shared/types/project';

interface GlobalMcpSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

// Helper to get model label from short name
function getModelLabel(modelShort: ModelTypeShort): string {
  const model = AVAILABLE_MODELS.find(m => m.value === modelShort);
  return model?.label.replace('Claude ', '') || modelShort;
}

// Helper to get thinking label from level
function getThinkingLabel(level: ThinkingLevel): string {
  const thinking = THINKING_LEVELS.find(t => t.value === level);
  return thinking?.label || level;
}

/**
 * Global MCP Settings section
 * Configures default MCP servers that apply to all projects unless overridden.
 * Built-in server toggles + custom server management + Claude Code imports +
 * per-agent MCP defaults grid.
 */
export function GlobalMcpSettings({ settings, onSettingsChange }: GlobalMcpSettingsProps) {
  const { t } = useTranslation('settings');
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false);
  const [editingCustomServer, setEditingCustomServer] = useState<CustomMcpServer | null>(null);

  // Claude Code imported servers state
  const [claudeCodeServers, setClaudeCodeServers] = useState<CustomMcpServer[]>([]);
  const [healthStatuses, setHealthStatuses] = useState<Record<string, McpHealthCheckResult>>({});
  const [testingServers, setTestingServers] = useState<Set<string>>(new Set());

  // Per-agent defaults: collapsible categories (Spec/Build/QA expanded by default)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['spec', 'build', 'qa'])
  );

  const globalMcp: GlobalMcpServers = settings.globalMcpServers ?? {};
  const customServers: CustomMcpServer[] = settings.globalCustomMcpServers ?? [];

  // Resolve agent model/thinking settings for display labels
  const resolvedSettings = useResolvedAgentSettings(settings);

  // Fetch Claude Code MCP servers on mount
  useEffect(() => {
    window.electronAPI.getClaudeCodeMcpServers()
      .then((result) => {
        if (result.success && result.data) {
          setClaudeCodeServers(result.data);
        }
      })
      .catch(() => { /* ignore - no Claude Code servers available */ });
  }, []);

  // Test a single server connection
  const handleTestConnection = useCallback(async (server: CustomMcpServer) => {
    setTestingServers(prev => new Set(prev).add(server.id));
    try {
      const result = await window.electronAPI.testMcpConnection(server);
      if (result.success && result.data) {
        setHealthStatuses(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: result.data!.success ? 'healthy' : 'unhealthy',
            message: result.data!.message,
            checkedAt: new Date().toISOString(),
          },
        }));
      }
    } catch (_error) {
      setHealthStatuses(prev => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'unknown',
          message: 'Connection test failed',
          checkedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setTestingServers(prev => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  }, []);

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

  // Toggle category expansion for per-agent grid
  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Derive mcpServerStates from global MCP toggle settings
  const mcpServerStates = {
    context7Enabled: globalMcp.context7Enabled !== false,
    linearMcpEnabled: globalMcp.linearMcpEnabled !== false,
    electronEnabled: globalMcp.electronEnabled === true,
    puppeteerEnabled: globalMcp.puppeteerEnabled === true,
  };

  // Handle adding an MCP to an agent (in-memory via onSettingsChange)
  const handleAddMcp = useCallback((agentId: string, mcpId: string) => {
    const currentOverrides = settings.globalAgentMcpOverrides ?? {};
    const agentOverride: AgentMcpOverride = currentOverrides[agentId] ?? {};

    let newOverride: AgentMcpOverride;
    if (agentOverride.remove?.includes(mcpId)) {
      // If it's in the remove list, take it out (restore)
      newOverride = {
        ...agentOverride,
        remove: agentOverride.remove.filter(m => m !== mcpId),
      };
    } else {
      // Otherwise, add it to the add list
      newOverride = {
        ...agentOverride,
        add: [...(agentOverride.add ?? []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
      };
    }

    // Clean up empty arrays
    if (newOverride.add?.length === 0) delete newOverride.add;
    if (newOverride.remove?.length === 0) delete newOverride.remove;

    const newOverrides = { ...currentOverrides };
    if (Object.keys(newOverride).length === 0) {
      delete newOverrides[agentId];
    } else {
      newOverrides[agentId] = newOverride;
    }

    onSettingsChange({
      ...settings,
      globalAgentMcpOverrides: newOverrides,
    });
  }, [settings, onSettingsChange]);

  // Handle removing an MCP from an agent (in-memory via onSettingsChange)
  const handleRemoveMcp = useCallback((agentId: string, mcpId: string) => {
    const currentOverrides = settings.globalAgentMcpOverrides ?? {};
    const agentOverride: AgentMcpOverride = currentOverrides[agentId] ?? {};

    let newOverride: AgentMcpOverride;
    if (agentOverride.add?.includes(mcpId)) {
      // If it's in the add list, take it out
      newOverride = {
        ...agentOverride,
        add: agentOverride.add.filter(m => m !== mcpId),
      };
    } else {
      // Otherwise, add it to the remove list
      newOverride = {
        ...agentOverride,
        remove: [...(agentOverride.remove ?? []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
      };
    }

    // Clean up empty arrays
    if (newOverride.add?.length === 0) delete newOverride.add;
    if (newOverride.remove?.length === 0) delete newOverride.remove;

    const newOverrides = { ...currentOverrides };
    if (Object.keys(newOverride).length === 0) {
      delete newOverrides[agentId];
    } else {
      newOverrides[agentId] = newOverride;
    }

    onSettingsChange({
      ...settings,
      globalAgentMcpOverrides: newOverrides,
    });
  }, [settings, onSettingsChange]);

  // Combined custom servers for agent cards: global custom + Claude Code imports
  const allCustomServers = [...customServers, ...claudeCodeServers];

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

        {/* Claude Code Imported MCP Servers */}
        {claudeCodeServers.length > 0 && (
          <div className="pt-4 border-t border-border">
            <div className="flex items-center gap-2 mb-3">
              <Code className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                {t('mcp.claudeCodeServers')}
              </span>
              <span className="text-[10px] text-muted-foreground/60 ml-auto">
                ~/.claude.json
              </span>
            </div>
            <div className="space-y-2">
              {claudeCodeServers.map((server) => {
                const health = healthStatuses[server.id];
                const isChecking = health?.status === 'checking';
                const isTesting = testingServers.has(server.id);

                return (
                  <div
                    key={server.id}
                    className="flex items-center justify-between py-2 px-3 bg-muted/30 rounded-lg border border-border/30"
                  >
                    <div className="flex items-center gap-3">
                      {isChecking ? (
                        <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
                      ) : health?.status === 'healthy' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      ) : health?.status === 'unhealthy' ? (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {server.type === 'command' ? (
                        <Terminal className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Globe className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{server.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                            {t('mcp.claudeCodeBadge')}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {server.type === 'command'
                            ? `${server.command} ${server.args?.join(' ') || ''}`
                            : server.url}
                        </p>
                        {health?.status === 'unhealthy' && server.type === 'command' && (
                          <p className="text-xs text-amber-500">
                            {t('mcp.status.commandNotFound')}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTestConnection(server)}
                      disabled={isTesting || isChecking}
                      className="h-7 px-2 text-xs"
                      title={t('mcp.testConnection')}
                    >
                      {isTesting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      <span className="ml-1">{t('mcp.testConnection')}</span>
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Per-project overrides info note */}
        <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-xs text-muted-foreground">{t('globalMcp.infoNote')}</p>
        </div>

        {/* Per-Agent MCP Defaults Grid */}
        <div className="pt-4 border-t border-border">
          <div className="mb-4">
            <h4 className="text-sm font-medium text-foreground">
              {t('globalMcp.agentDefaults')}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t('globalMcp.agentDefaultsDescription')}
            </p>
          </div>

          <div className="space-y-3">
            {Object.entries(CATEGORIES).map(([categoryId, categoryInfo]) => {
              const isExpanded = expandedCategories.has(categoryId);
              const categoryAgents = Object.entries(AGENT_CONFIGS).filter(
                ([, config]) => config.category === categoryId
              );

              if (categoryAgents.length === 0) return null;

              const CategoryIcon = categoryInfo.icon;

              return (
                <div key={categoryId}>
                  {/* Category header */}
                  <button
                    type="button"
                    onClick={() => toggleCategory(categoryId)}
                    className="flex items-center gap-2 w-full text-left py-1.5 px-1 hover:bg-muted/50 rounded transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <CategoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      {categoryInfo.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">
                      ({categoryAgents.length})
                    </span>
                  </button>

                  {/* Agent cards */}
                  {isExpanded && (
                    <div className="mt-2 space-y-2 pl-1">
                      {categoryAgents.map(([agentId, config]) => {
                        const { model, thinking } = resolveAgentSettings(
                          config.settingsSource,
                          resolvedSettings
                        );

                        return (
                          <AgentMcpCard
                            key={agentId}
                            id={agentId}
                            config={config}
                            modelLabel={getModelLabel(model)}
                            thinkingLabel={getThinkingLabel(thinking)}
                            overrides={settings.globalAgentMcpOverrides?.[agentId]}
                            mcpServerStates={mcpServerStates}
                            customServers={allCustomServers}
                            onAddMcp={handleAddMcp}
                            onRemoveMcp={handleRemoveMcp}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Per-agent defaults note */}
          <div className="flex items-start gap-2 mt-4 p-3 bg-muted/50 rounded-lg">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted-foreground">{t('globalMcp.agentDefaultsNote')}</p>
          </div>
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
