/**
 * Application configuration constants
 * Default settings, file paths, and project structure
 */

// ============================================
// Terminal Timing Constants
// ============================================

/** Delay for DOM updates before terminal operations (refit, resize).
 * Must be long enough for dnd-kit CSS transitions to complete after drag-drop reorder.
 * 50ms was too short, causing xterm to fit into containers with zero/invalid dimensions. */
export const TERMINAL_DOM_UPDATE_DELAY_MS = 250;

/** Grace period before cleaning up error panel constraints after panel removal */
export const PANEL_CLEANUP_GRACE_PERIOD_MS = 150;

// ============================================
// UI Scale Constants
// ============================================

export const UI_SCALE_MIN = 75;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_STEP = 5;

// ============================================
// Default App Settings
// ============================================

export const DEFAULT_APP_SETTINGS = {
  theme: 'dark' as const,
  colorTheme: 'default' as const,
  defaultModel: 'opus',
  agentFramework: 'auto-claude',
  pythonPath: undefined as string | undefined,
  gitPath: undefined as string | undefined,
  githubCLIPath: undefined as string | undefined,
  gitlabCLIPath: undefined as string | undefined,
  autoBuildPath: undefined as string | undefined,
  autoUpdateAutoBuild: true,
  autoNameTerminals: true,
  onboardingCompleted: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    onPRReviewComplete: true,
    onClaudeSessionComplete: true,
    sound: false
  },
  // Global API keys (used as defaults for all projects)
  globalClaudeOAuthToken: undefined as string | undefined,
  globalOpenAIApiKey: undefined as string | undefined,
  // Selected agent profile - defaults to 'auto' for per-phase optimized model selection
  selectedAgentProfile: 'auto',
  // Changelog preferences (persisted between sessions)
  changelogFormat: 'keep-a-changelog' as const,
  changelogAudience: 'user-facing' as const,
  changelogEmojiLevel: 'none' as const,
  // UI Scale (default 100% - standard size)
  uiScale: UI_SCALE_DEFAULT,
  // Log order setting for task detail view (default chronological - oldest first)
  logOrder: 'chronological' as const,
  // Beta updates opt-in (receive pre-release versions)
  betaUpdates: false,
  // Language preference (default to English)
  language: 'en' as const,
  // Anonymous error reporting (Sentry) - enabled by default to help improve the app
  sentryEnabled: true,
  // Auto-name Claude terminals based on initial message (enabled by default)
  autoNameClaudeTerminals: true,
  // GPU acceleration for terminal rendering
  // Default to 'off' until WebGL stability is proven across all GPU drivers.
  // Users can opt-in via Settings > Display > GPU Acceleration.
  gpuAcceleration: 'off' as const
};

// ============================================
// Default Project Settings
// ============================================

export const DEFAULT_PROJECT_SETTINGS = {
  model: 'opus',
  memoryBackend: 'file' as const,
  linearSync: false,
  notifications: {
    onTaskComplete: true,
    onTaskFailed: true,
    onReviewNeeded: true,
    onPRReviewComplete: true,
    onClaudeSessionComplete: true,
    sound: false
  },
  // Graphiti MCP server for agent-accessible knowledge graph (enabled by default)
  graphitiMcpEnabled: true,
  graphitiMcpUrl: 'http://localhost:8000/mcp/',
  // Include CLAUDE.md instructions in agent context (enabled by default)
  useClaudeMd: true,
  // Custom display name for project tab (undefined = use default project name)
  customTabName: undefined as string | undefined,
  // Color tint for the project tab (undefined = no color tint)
  tabColor: undefined as string | undefined
};

// ============================================
// Tab Color Constants
// ============================================

/** Available color tints for project tabs. All class strings are literal for Tailwind JIT safety. */
export const TAB_COLORS = [
  { id: 'red', bg: 'bg-red-500/10', swatch: 'bg-red-500', labelKey: 'projectTab.colorRed' },
  { id: 'orange', bg: 'bg-orange-500/10', swatch: 'bg-orange-500', labelKey: 'projectTab.colorOrange' },
  { id: 'yellow', bg: 'bg-yellow-500/10', swatch: 'bg-yellow-500', labelKey: 'projectTab.colorYellow' },
  { id: 'green', bg: 'bg-green-500/10', swatch: 'bg-green-500', labelKey: 'projectTab.colorGreen' },
  { id: 'blue', bg: 'bg-blue-500/10', swatch: 'bg-blue-500', labelKey: 'projectTab.colorBlue' },
  { id: 'purple', bg: 'bg-purple-500/10', swatch: 'bg-purple-500', labelKey: 'projectTab.colorPurple' },
  { id: 'pink', bg: 'bg-pink-500/10', swatch: 'bg-pink-500', labelKey: 'projectTab.colorPink' },
] as const;

// ============================================
// Tab Group Color Constants
// ============================================

/** Chrome-style color palette for project tab groups. All class strings are literal for Tailwind JIT safety. */
export const TAB_GROUP_COLORS = [
  { id: 'grey', bg: 'bg-gray-500/10', chip: 'bg-gray-500', border: 'border-gray-500', labelKey: 'tabGroup.colorGrey' },
  { id: 'blue', bg: 'bg-blue-500/10', chip: 'bg-blue-500', border: 'border-blue-500', labelKey: 'tabGroup.colorBlue' },
  { id: 'red', bg: 'bg-red-500/10', chip: 'bg-red-500', border: 'border-red-500', labelKey: 'tabGroup.colorRed' },
  { id: 'yellow', bg: 'bg-yellow-500/10', chip: 'bg-yellow-500', border: 'border-yellow-500', labelKey: 'tabGroup.colorYellow' },
  { id: 'green', bg: 'bg-green-500/10', chip: 'bg-green-500', border: 'border-green-500', labelKey: 'tabGroup.colorGreen' },
  { id: 'pink', bg: 'bg-pink-500/10', chip: 'bg-pink-500', border: 'border-pink-500', labelKey: 'tabGroup.colorPink' },
  { id: 'purple', bg: 'bg-purple-500/10', chip: 'bg-purple-500', border: 'border-purple-500', labelKey: 'tabGroup.colorPurple' },
  { id: 'cyan', bg: 'bg-cyan-500/10', chip: 'bg-cyan-500', border: 'border-cyan-500', labelKey: 'tabGroup.colorCyan' },
] as const;

// ============================================
// Auto Build File Paths
// ============================================

// File paths relative to project
// IMPORTANT: All paths use .auto-claude/ (the installed instance), NOT auto-claude/ (source code)
export const AUTO_BUILD_PATHS = {
  SPECS_DIR: '.auto-claude/specs',
  ROADMAP_DIR: '.auto-claude/roadmap',
  IDEATION_DIR: '.auto-claude/ideation',
  IMPLEMENTATION_PLAN: 'implementation_plan.json',
  SPEC_FILE: 'spec.md',
  QA_REPORT: 'qa_report.md',
  BUILD_PROGRESS: 'build-progress.txt',
  GENERATION_PROGRESS: 'generation_progress.json',
  CONTEXT: 'context.json',
  REQUIREMENTS: 'requirements.json',
  ROADMAP_FILE: 'roadmap.json',
  ROADMAP_DISCOVERY: 'roadmap_discovery.json',
  COMPETITOR_ANALYSIS: 'competitor_analysis.json',
  MANUAL_COMPETITORS: 'manual_competitors.json',
  IDEATION_FILE: 'ideation.json',
  IDEATION_CONTEXT: 'ideation_context.json',
  PROJECT_INDEX: '.auto-claude/project_index.json',
  GRAPHITI_STATE: '.graphiti_state.json'
} as const;

/**
 * Get the specs directory path.
 * All specs go to .auto-claude/specs/ (the project's data directory).
 */
export function getSpecsDir(autoBuildPath: string | undefined): string {
  const basePath = autoBuildPath || '.auto-claude';
  return `${basePath}/specs`;
}
