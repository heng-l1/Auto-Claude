/**
 * Central export point for all constants
 * Re-exports from domain-specific constant modules
 */

// Phase event protocol constants (Python ↔ TypeScript)
export * from './phase-protocol';

// IPC Channel constants
export * from './ipc';

// Task-related constants
export * from './task';

// Roadmap constants
export * from './roadmap';

// Ideation constants
export * from './ideation';

// Changelog constants
export * from './changelog';

// Model and agent profile constants
export * from './models';

// Theme constants
export * from './themes';

// GitHub integration constants
export * from './github';

// API profile presets
export * from './api-profiles';

// Configuration and paths
export * from './config';

// Spell check configuration
export * from './spellcheck';

// NOTE: agent-mcp.ts is NOT re-exported here because it imports lucide-react (a React
// component library). Barrel-exporting it would pull React into the Electron main process
// where React is unavailable, crashing the packaged app. Renderer files that need
// agent-mcp exports import directly from './agent-mcp' instead.
