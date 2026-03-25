/**
 * Agent Tools Overview
 *
 * Displays MCP server and tool configuration for each agent phase.
 * Helps users understand what tools are available during different execution phases.
 * Now shows per-project MCP configuration with toggles to enable/disable servers.
 */

import {
  Server,
  Brain,
  Code,
  Search,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Monitor,
  Globe,
  ClipboardList,
  ListChecks,
  Info,
  AlertCircle,
  Plus,
  Pencil,
  Trash2,
  Terminal,
  Loader2,
  RefreshCw,
  Lock
} from 'lucide-react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { ScrollArea } from './ui/scroll-area';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { useSettingsStore } from '../stores/settings-store';
import { useProjectStore } from '../stores/project-store';
import type { ProjectEnvConfig, AgentMcpOverride, CustomMcpServer, McpHealthCheckResult } from '../../shared/types';
import { CustomMcpDialog } from './CustomMcpDialog';
import { useTranslation } from 'react-i18next';
import {
  AVAILABLE_MODELS,
  THINKING_LEVELS,
} from '../../shared/constants/models';
import {
  type AgentConfig,
  AGENT_CONFIGS,
  CATEGORIES,
} from '../../shared/constants/agent-mcp';
import { AgentMcpCard } from './settings/AgentMcpCard';
import {
  useResolvedAgentSettings,
  resolveAgentSettings as resolveAgentModelConfig,
} from '../hooks';
import type { ModelTypeShort, ThinkingLevel } from '../../shared/types/settings';

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

export function AgentTools() {
  const { t } = useTranslation(['settings']);
  const settings = useSettingsStore((state) => state.settings);
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['spec', 'build', 'qa'])
  );
  const [envConfig, setEnvConfig] = useState<ProjectEnvConfig | null>(null);
  const [, setIsLoading] = useState(false);

  // Custom MCP server dialog state
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false);
  const [editingCustomServer, setEditingCustomServer] = useState<CustomMcpServer | null>(null);

  // Health status tracking for custom servers
  const [serverHealthStatus, setServerHealthStatus] = useState<Record<string, McpHealthCheckResult>>({});
  const [testingServers, setTestingServers] = useState<Set<string>>(new Set());

  // MCP servers imported from Claude Code (~/.claude.json)
  const [claudeCodeServers, setClaudeCodeServers] = useState<CustomMcpServer[]>([]);

  // Load Claude Code MCP servers on mount
  useEffect(() => {
    window.electronAPI.getClaudeCodeMcpServers()
      .then((result) => {
        if (result.success && result.data) {
          setClaudeCodeServers(result.data);
        }
      })
      .catch(() => { /* ignore */ });
  }, []);

  // Load project env config when project changes
  useEffect(() => {
    if (selectedProjectId && selectedProject?.autoBuildPath) {
      setIsLoading(true);
      window.electronAPI.getProjectEnv(selectedProjectId)
        .then((result) => {
          if (result.success && result.data) {
            setEnvConfig(result.data);
          } else {
            setEnvConfig(null);
          }
        })
        .catch(() => {
          setEnvConfig(null);
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      setEnvConfig(null);
    }
  }, [selectedProjectId, selectedProject?.autoBuildPath]);

  // Update MCP server toggle
  const updateMcpServer = useCallback(async (
    key: keyof NonNullable<ProjectEnvConfig['mcpServers']>,
    value: boolean
  ) => {
    if (!selectedProjectId || !envConfig) return;

    const newMcpServers = {
      ...envConfig.mcpServers,
      [key]: value,
    };

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, mcpServers: newMcpServers } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        mcpServers: newMcpServers,
      });
    } catch (error) {
      // Revert on error
      console.error('Failed to update MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, mcpServers: envConfig.mcpServers } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle adding an MCP to an agent
  const handleAddMcp = useCallback(async (agentId: string, mcpId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const currentOverrides = envConfig.agentMcpOverrides || {};
    const agentOverride = currentOverrides[agentId] || {};

    // If it's in the remove list, take it out (restore)
    // Otherwise, add it to the add list
    let newOverride: AgentMcpOverride;
    if (agentOverride.remove?.includes(mcpId)) {
      newOverride = {
        ...agentOverride,
        remove: agentOverride.remove.filter(m => m !== mcpId),
      };
    } else {
      newOverride = {
        ...agentOverride,
        add: [...(agentOverride.add || []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
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

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: newOverrides } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to update agent MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle removing an MCP from an agent
  const handleRemoveMcp = useCallback(async (agentId: string, mcpId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const agentConfig = AGENT_CONFIGS[agentId];
    const defaults = [...(agentConfig?.mcp_servers || []), ...(agentConfig?.mcp_optional || [])];
    const isDefault = defaults.includes(mcpId);

    const currentOverrides = envConfig.agentMcpOverrides || {};
    const agentOverride = currentOverrides[agentId] || {};

    let newOverride: AgentMcpOverride;
    if (isDefault) {
      // It's a default MCP - add to remove list
      newOverride = {
        ...agentOverride,
        remove: [...(agentOverride.remove || []), mcpId].filter((v, i, a) => a.indexOf(v) === i),
      };
    } else {
      // It's a custom addition - remove from add list
      newOverride = {
        ...agentOverride,
        add: (agentOverride.add || []).filter(m => m !== mcpId),
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

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: newOverrides } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to update agent MCP config:', error);
      setEnvConfig((prev) => prev ? { ...prev, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Reset MCP override to global default
  const resetMcpOverride = useCallback(async (key: string) => {
    if (!selectedProjectId) return;

    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        clearMcpServerOverrides: [key],
      });
      // Re-fetch env config to get updated state
      const result = await window.electronAPI.getProjectEnv(selectedProjectId);
      if (result.success && result.data) {
        setEnvConfig(result.data);
      }
    } catch (error) {
      console.error('Failed to reset MCP override:', error);
    }
  }, [selectedProjectId]);

  // Handle saving a custom MCP server
  const handleSaveCustomServer = useCallback(async (server: CustomMcpServer) => {
    if (!selectedProjectId || !envConfig) return;

    const currentServers = envConfig.customMcpServers || [];
    const existingIndex = currentServers.findIndex(s => s.id === server.id);

    let newServers: CustomMcpServer[];
    if (existingIndex >= 0) {
      // Update existing
      newServers = [...currentServers];
      newServers[existingIndex] = server;
    } else {
      // Add new
      newServers = [...currentServers, server];
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? { ...prev, customMcpServers: newServers } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        customMcpServers: newServers,
      });
    } catch (error) {
      console.error('Failed to save custom MCP server:', error);
      setEnvConfig((prev) => prev ? { ...prev, customMcpServers: currentServers } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Handle deleting a custom MCP server
  const handleDeleteCustomServer = useCallback(async (serverId: string) => {
    if (!selectedProjectId || !envConfig) return;

    const currentServers = envConfig.customMcpServers || [];
    const newServers = currentServers.filter(s => s.id !== serverId);

    // Also remove from any agent overrides that reference it
    const currentOverrides = envConfig.agentMcpOverrides || {};
    const newOverrides = { ...currentOverrides };
    for (const agentId of Object.keys(newOverrides)) {
      const override = newOverrides[agentId];
      if (override.add?.includes(serverId)) {
        newOverrides[agentId] = {
          ...override,
          add: override.add.filter(m => m !== serverId),
        };
        if (newOverrides[agentId].add?.length === 0) {
          delete newOverrides[agentId].add;
        }
        if (Object.keys(newOverrides[agentId]).length === 0) {
          delete newOverrides[agentId];
        }
      }
    }

    // Optimistic update
    setEnvConfig((prev) => prev ? {
      ...prev,
      customMcpServers: newServers,
      agentMcpOverrides: newOverrides,
    } : null);

    // Save to backend
    try {
      await window.electronAPI.updateProjectEnv(selectedProjectId, {
        customMcpServers: newServers,
        agentMcpOverrides: newOverrides,
      });
    } catch (error) {
      console.error('Failed to delete custom MCP server:', error);
      setEnvConfig((prev) => prev ? { ...prev, customMcpServers: currentServers, agentMcpOverrides: currentOverrides } : null);
    }
  }, [selectedProjectId, envConfig]);

  // Check health of all custom and imported MCP servers
  const checkAllServersHealth = useCallback(async () => {
    const servers = [...(envConfig?.customMcpServers || []), ...claudeCodeServers];
    if (servers.length === 0) return;

    for (const server of servers) {
      // Set checking status
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'checking',
          checkedAt: new Date().toISOString(),
        }
      }));

      try {
        const result = await window.electronAPI.checkMcpHealth(server);
        if (result.success && result.data) {
          setServerHealthStatus(prev => ({
            ...prev,
            [server.id]: result.data!,
          }));
        }
      } catch (_error) {
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: 'unknown',
            message: 'Health check failed',
            checkedAt: new Date().toISOString(),
          }
        }));
      }
    }
  }, [envConfig?.customMcpServers, claudeCodeServers]);

  // Check health when custom servers or Claude Code servers change
  useEffect(() => {
    const allServers = [...(envConfig?.customMcpServers || []), ...claudeCodeServers];
    if (allServers.length > 0) {
      checkAllServersHealth();
    }
  }, [envConfig?.customMcpServers, claudeCodeServers, checkAllServersHealth]);

  // Test a single server connection (full test)
  const handleTestConnection = useCallback(async (server: CustomMcpServer) => {
    setTestingServers(prev => new Set(prev).add(server.id));

    try {
      const result = await window.electronAPI.testMcpConnection(server);
      if (result.success && result.data) {
        // Update health status based on test result
        setServerHealthStatus(prev => ({
          ...prev,
          [server.id]: {
            serverId: server.id,
            status: result.data?.success ? 'healthy' : 'unhealthy',
            message: result.data?.message,
            responseTime: result.data?.responseTime,
            checkedAt: new Date().toISOString(),
          }
        }));
      }
    } catch (_error) {
      setServerHealthStatus(prev => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'unhealthy',
          message: 'Connection test failed',
          checkedAt: new Date().toISOString(),
        }
      }));
    } finally {
      setTestingServers(prev => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  }, []);

  // Resolve agent settings using the centralized utility
  // Resolution order: custom overrides -> selected profile's config -> global defaults
  const { phaseModels, phaseThinking, featureModels, featureThinking } = useResolvedAgentSettings(settings);

  // Get MCP server states for display
  const mcpServers = envConfig?.mcpServers || {};

  // Count enabled MCP servers
  const enabledCount = [
    mcpServers.context7Enabled !== false,
    mcpServers.graphitiEnabled && envConfig?.graphitiProviderConfig,
    mcpServers.linearMcpEnabled !== false && envConfig?.linearEnabled,
    mcpServers.electronEnabled,
    mcpServers.puppeteerEnabled,
    true, // auto-claude always enabled
  ].filter(Boolean).length;

  // Separate custom MCP servers into project-level and global groups
  const { projectCustomServers, globalCustomServers, overridesGlobalIds } = useMemo(() => {
    const allServers = envConfig?.customMcpServers || [];
    const globalIds = new Set(envConfig?.globalCustomMcpServerIds || []);
    const allGlobalSettingsIds = new Set(
      (settings?.globalCustomMcpServers || []).map(s => s.id)
    );

    return {
      projectCustomServers: allServers.filter(s => !globalIds.has(s.id)),
      globalCustomServers: allServers.filter(s => globalIds.has(s.id)),
      overridesGlobalIds: new Set(
        allServers
          .filter(s => !globalIds.has(s.id) && allGlobalSettingsIds.has(s.id))
          .map(s => s.id)
      ),
    };
  }, [envConfig?.customMcpServers, envConfig?.globalCustomMcpServerIds, settings?.globalCustomMcpServers]);

  // Resolve model and thinking for an agent based on its settings source
  const getAgentModelConfig = useMemo(() => {
    return (config: AgentConfig): { model: ModelTypeShort; thinking: ThinkingLevel } => {
      return resolveAgentModelConfig(config.settingsSource, { phaseModels, phaseThinking, featureModels, featureThinking });
    };
  }, [phaseModels, phaseThinking, featureModels, featureThinking]);

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

  // Group agents by category
  const agentsByCategory = Object.entries(AGENT_CONFIGS).reduce(
    (acc, [id, config]) => {
      const category = config.category;
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push({ id, config });
      return acc;
    },
    {} as Record<string, Array<{ id: string; config: typeof AGENT_CONFIGS[keyof typeof AGENT_CONFIGS] }>>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-muted">
            <Server className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-foreground">MCP Server Overview</h1>
              {selectedProject && (
                <span className="text-sm text-muted-foreground">
                  for {selectedProject.name}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {selectedProject
                ? t('settings:mcp.description')
                : t('settings:mcp.descriptionNoProject')}
            </p>
          </div>
          {envConfig && (
            <div className="text-right">
              <span className="text-sm text-muted-foreground">{t('settings:mcp.serversEnabled', { count: enabledCount })}</span>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {/* No project selected message */}
          {!selectedProject && (
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <AlertCircle className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <h2 className="text-sm font-medium text-foreground mb-1">{t('settings:mcp.noProjectSelected')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('settings:mcp.noProjectSelectedDescription')}
              </p>
            </div>
          )}

          {/* Project not initialized message */}
          {selectedProject && !selectedProject.autoBuildPath && (
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <Info className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <h2 className="text-sm font-medium text-foreground mb-1">{t('settings:mcp.projectNotInitialized')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('settings:mcp.projectNotInitializedDescription')}
              </p>
            </div>
          )}

          {/* MCP Server Configuration */}
          {envConfig && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-foreground">{t('settings:mcp.configuration')}</h2>
                <span className="text-xs text-muted-foreground">
                  {t('settings:mcp.configurationHint')}
                </span>
              </div>

              <div className="space-y-4">
                {/* Context7 */}
                <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.context7.name')}</span>
                      <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.context7.description')}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {envConfig.mcpServersOverridden?.context7Enabled ? (
                      <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        {t('settings:mcp.projectOverride')}
                        <button
                          type="button"
                          onClick={() => resetMcpOverride('context7Enabled')}
                          className="ml-1 hover:opacity-70"
                          title={t('settings:mcp.resetToGlobal')}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {t('settings:mcp.globalDefault')}
                      </span>
                    )}
                    <Switch
                      checked={mcpServers.context7Enabled !== false}
                      onCheckedChange={(checked) => updateMcpServer('context7Enabled', checked)}
                    />
                  </div>
                </div>

                {/* Graphiti Memory */}
                <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <Brain className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.graphiti.name')}</span>
                      <p className="text-xs text-muted-foreground">
                        {envConfig.graphitiProviderConfig
                          ? t('settings:mcp.servers.graphiti.description')
                          : t('settings:mcp.servers.graphiti.notConfigured')}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={mcpServers.graphitiEnabled !== false && !!envConfig.graphitiProviderConfig}
                    onCheckedChange={(checked) => updateMcpServer('graphitiEnabled', checked)}
                    disabled={!envConfig.graphitiProviderConfig}
                  />
                </div>

                {/* Linear */}
                <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <ClipboardList className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.linear.name')}</span>
                      <p className="text-xs text-muted-foreground">
                        {envConfig.linearEnabled
                          ? t('settings:mcp.servers.linear.description')
                          : t('settings:mcp.servers.linear.notConfigured')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {envConfig.mcpServersOverridden?.linearMcpEnabled ? (
                      <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        {t('settings:mcp.projectOverride')}
                        <button
                          type="button"
                          onClick={() => resetMcpOverride('linearMcpEnabled')}
                          className="ml-1 hover:opacity-70"
                          title={t('settings:mcp.resetToGlobal')}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {t('settings:mcp.globalDefault')}
                      </span>
                    )}
                    <Switch
                      checked={mcpServers.linearMcpEnabled !== false && envConfig.linearEnabled}
                      onCheckedChange={(checked) => updateMcpServer('linearMcpEnabled', checked)}
                      disabled={!envConfig.linearEnabled}
                    />
                  </div>
                </div>

                {/* Browser Automation Section */}
                <div className="pt-2">
                  <div className="flex items-center gap-2 mb-3">
                    <Info className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">
                      {t('settings:mcp.browserAutomation')}
                    </span>
                  </div>

                  {/* Electron */}
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <div className="flex items-center gap-3">
                      <Monitor className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <span className="text-sm font-medium">{t('settings:mcp.servers.electron.name')}</span>
                        <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.electron.description')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {envConfig.mcpServersOverridden?.electronEnabled ? (
                        <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
                          {t('settings:mcp.projectOverride')}
                          <button
                            type="button"
                            onClick={() => resetMcpOverride('electronEnabled')}
                            className="ml-1 hover:opacity-70"
                            title={t('settings:mcp.resetToGlobal')}
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {t('settings:mcp.globalDefault')}
                        </span>
                      )}
                      <Switch
                        checked={mcpServers.electronEnabled === true}
                        onCheckedChange={(checked) => updateMcpServer('electronEnabled', checked)}
                      />
                    </div>
                  </div>

                  {/* Puppeteer */}
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-3">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <span className="text-sm font-medium">{t('settings:mcp.servers.puppeteer.name')}</span>
                        <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.puppeteer.description')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {envConfig.mcpServersOverridden?.puppeteerEnabled ? (
                        <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
                          {t('settings:mcp.projectOverride')}
                          <button
                            type="button"
                            onClick={() => resetMcpOverride('puppeteerEnabled')}
                            className="ml-1 hover:opacity-70"
                            title={t('settings:mcp.resetToGlobal')}
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {t('settings:mcp.globalDefault')}
                        </span>
                      )}
                      <Switch
                        checked={mcpServers.puppeteerEnabled === true}
                        onCheckedChange={(checked) => updateMcpServer('puppeteerEnabled', checked)}
                      />
                    </div>
                  </div>
                </div>

                {/* Auto-Claude (always enabled) */}
                <div className="flex items-center justify-between py-2 border-t border-border opacity-60">
                  <div className="flex items-center gap-3">
                    <ListChecks className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">{t('settings:mcp.servers.autoClaude.name')}</span>
                      <p className="text-xs text-muted-foreground">{t('settings:mcp.servers.autoClaude.description')} ({t('settings:mcp.alwaysEnabled')})</p>
                    </div>
                  </div>
                  <Switch checked={true} disabled />
                </div>

                {/* Custom MCP Servers Section */}
                <div className="pt-4 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">
                        {t('settings:mcp.customServers')}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setEditingCustomServer(null); setShowCustomMcpDialog(true); }}
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      <Plus className="h-3 w-3" />
                      {t('settings:mcp.addCustomServer')}
                    </button>
                  </div>

                  {(projectCustomServers.length > 0 || globalCustomServers.length > 0) ? (
                    <div className="space-y-2">
                      {/* Project-level custom servers */}
                      {projectCustomServers.map((server) => {
                        const health = serverHealthStatus[server.id];
                        const isTesting = testingServers.has(server.id);
                        const isChecking = health?.status === 'checking';
                        const isOverridingGlobal = overridesGlobalIds.has(server.id);

                        // Status indicator component
                        const StatusIndicator = () => {
                          if (isTesting || isChecking) {
                            return <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />;
                          }
                          switch (health?.status) {
                            case 'healthy':
                              return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
                            case 'needs_auth':
                              return <Lock className="h-3.5 w-3.5 text-amber-500" />;
                            case 'unhealthy':
                              return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
                            default:
                              return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
                          }
                        };

                        return (
                          <div
                            key={server.id}
                            className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-lg group"
                          >
                            <div className="flex items-center gap-3">
                              {/* Status indicator */}
                              <StatusIndicator />
                              {server.type === 'command' ? (
                                <Terminal className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <Globe className="h-4 w-4 text-muted-foreground" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">{server.name}</span>
                                  {isOverridingGlobal && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                      {t('settings:mcp.overridesGlobal')}
                                    </span>
                                  )}
                                  {health?.responseTime && (
                                    <span className="text-[10px] text-muted-foreground">
                                      {health.responseTime}ms
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground truncate">
                                  {health?.message || (server.type === 'command'
                                    ? `${server.command} ${server.args?.join(' ') || ''}`
                                    : server.url)}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              {/* Test button - always visible */}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleTestConnection(server)}
                                disabled={isTesting}
                                className="h-7 px-2 text-xs"
                                title="Test Connection"
                              >
                                {isTesting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3 w-3" />
                                )}
                                <span className="ml-1">Test</span>
                              </Button>
                              {/* Edit/Delete - show on hover */}
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  type="button"
                                  onClick={() => { setEditingCustomServer(server); setShowCustomMcpDialog(true); }}
                                  className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                                  title="Edit"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteCustomServer(server.id)}
                                  className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                                  title="Delete"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {/* Global custom servers (read-only) */}
                      {globalCustomServers.map((server) => {
                        const health = serverHealthStatus[server.id];
                        const isTesting = testingServers.has(server.id);
                        const isChecking = health?.status === 'checking';

                        // Status indicator component
                        const StatusIndicator = () => {
                          if (isTesting || isChecking) {
                            return <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />;
                          }
                          switch (health?.status) {
                            case 'healthy':
                              return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
                            case 'needs_auth':
                              return <Lock className="h-3.5 w-3.5 text-amber-500" />;
                            case 'unhealthy':
                              return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
                            default:
                              return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
                          }
                        };

                        return (
                          <div
                            key={server.id}
                            className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-lg"
                          >
                            <div className="flex items-center gap-3">
                              {/* Status indicator */}
                              <StatusIndicator />
                              {server.type === 'command' ? (
                                <Terminal className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <Globe className="h-4 w-4 text-muted-foreground" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">{server.name}</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
                                    {t('settings:mcp.globalBadge')}
                                  </span>
                                  {health?.responseTime && (
                                    <span className="text-[10px] text-muted-foreground">
                                      {health.responseTime}ms
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground truncate">
                                  {health?.message || (server.type === 'command'
                                    ? `${server.command} ${server.args?.join(' ') || ''}`
                                    : server.url)}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              {/* Test button - functional on global servers */}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleTestConnection(server)}
                                disabled={isTesting}
                                className="h-7 px-2 text-xs"
                                title="Test Connection"
                              >
                                {isTesting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3 w-3" />
                                )}
                                <span className="ml-1">Test</span>
                              </Button>
                              {/* No edit/delete buttons for global servers */}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-3">
                      {t('settings:mcp.noCustomServers')}
                    </p>
                  )}

                  {/* Claude Code Imported MCP Servers */}
                  {claudeCodeServers.length > 0 && (
                    <div className="pt-3 mt-3 border-t border-border/50">
                      <div className="flex items-center gap-2 mb-2">
                        <Code className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground uppercase tracking-wider">
                          {t('settings:mcp.claudeCodeServers')}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60 ml-auto">
                          ~/.claude.json
                        </span>
                      </div>
                      <div className="space-y-2">
                        {claudeCodeServers.map((server) => {
                          const health = serverHealthStatus[server.id];
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
                                      {t('settings:mcp.claudeCodeBadge')}
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground truncate">
                                    {server.type === 'command'
                                      ? `${server.command} ${server.args?.join(' ') || ''}`
                                      : server.url}
                                  </p>
                                  {health?.status === 'unhealthy' && server.type === 'command' && (
                                    <p className="text-xs text-amber-500">
                                      {t('settings:mcp.status.commandNotFound')}
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
                                title={t('settings:mcp.testConnection')}
                              >
                                {isTesting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3 w-3" />
                                )}
                                <span className="ml-1">{t('settings:mcp.testConnection')}</span>
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Agent Categories */}
          {Object.entries(CATEGORIES).map(([categoryId, category]) => {
            const agents = agentsByCategory[categoryId] || [];
            if (agents.length === 0) return null;

            const isExpanded = expandedCategories.has(categoryId);
            const CategoryIcon = category.icon;

            return (
              <div key={categoryId} className="space-y-3">
                {/* Category Header */}
                <button
                  type="button"
                  onClick={() => toggleCategory(categoryId)}
                  className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <CategoryIcon className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">
                    {category.label}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    ({agents.length} agents)
                  </span>
                </button>

                {/* Agent Cards */}
                {isExpanded && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pl-6">
                    {agents.map(({ id, config }) => {
                      const { model, thinking } = getAgentModelConfig(config);
                      const hasGlobalDefault = !!settings.globalAgentMcpOverrides?.[id] && !envConfig?.agentMcpOverrides?.[id];
                      return (
                        <div key={id} className="relative">
                          {hasGlobalDefault && (
                            <span className="absolute -top-2 right-2 z-10 px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground border border-border">
                              {t('mcp.globalDefault')}
                            </span>
                          )}
                          <AgentMcpCard
                            id={id}
                            config={config}
                            modelLabel={getModelLabel(model)}
                            thinkingLabel={getThinkingLabel(thinking)}
                            overrides={envConfig?.agentMcpOverrides?.[id]}
                            mcpServerStates={envConfig?.mcpServers}
                            customServers={[...(envConfig?.customMcpServers || []), ...claudeCodeServers]}
                            onAddMcp={handleAddMcp}
                            onRemoveMcp={handleRemoveMcp}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Custom MCP Server Dialog */}
      <CustomMcpDialog
        open={showCustomMcpDialog}
        onOpenChange={setShowCustomMcpDialog}
        server={editingCustomServer}
        existingIds={(envConfig?.customMcpServers || []).map(s => s.id)}
        onSave={handleSaveCustomServer}
      />
    </div>
  );
}
