/**
 * MCP Server API
 *
 * Exposes MCP health check and connection test functionality to the renderer.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import type { IPCResult } from '../../../shared/types/common';
import type { CustomMcpServer, McpHealthCheckResult, McpTestConnectionResult } from '../../../shared/types/project';

/** Result of a config sync operation for a single profile */
export type SyncResult =
  | { status: 'synced'; profileId: string; mcpsAdded: number; projectsAdded: number }
  | { status: 'noop'; profileId: string; reason: 'same-config' | 'no-user-content' | 'already-synced' }
  | { status: 'error'; profileId: string; message: string };

export interface McpAPI {
  /** Quick health check for a custom MCP server */
  checkMcpHealth: (server: CustomMcpServer) => Promise<IPCResult<McpHealthCheckResult>>;
  /** Full MCP connection test */
  testMcpConnection: (server: CustomMcpServer) => Promise<IPCResult<McpTestConnectionResult>>;
  /** Get MCP servers imported from Claude Code (~/.claude.json) */
  getClaudeCodeMcpServers: () => Promise<IPCResult<CustomMcpServer[]>>;
  /** Sync user-level Claude config (MCPs, projects) to all profiles */
  syncClaudeConfigToAllProfiles: () => Promise<IPCResult<SyncResult[]>>;
}

export function createMcpAPI(): McpAPI {
  return {
    checkMcpHealth: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, server),

    testMcpConnection: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, server),

    getClaudeCodeMcpServers: () =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_CLAUDE_CODE_SERVERS),

    syncClaudeConfigToAllProfiles: () =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CONFIG_SYNC_ALL_PROFILES),
  };
}
