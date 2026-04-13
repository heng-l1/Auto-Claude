# Changelog

All notable changes to Auto Claude will be documented in this file.

## 1.0.7 - Activity Center, Worktree Rebase & PR Review Enhancements

### ✨ New Features
- **Activity center** — Notification history popover with persistent storage, IPC events, and per-project navigation
- **Claude session notifications** — Get notified when Claude terminal sessions complete, with configurable toggle in settings
- **Worktree auto-rebase** — Existing worktrees automatically rebase onto base branch during setup
- **Per-subtask review gates** — Granular review control at the subtask level
- **PR review comment responses** — Respond to PR review comments directly from the app
- **Separate file-level and inline PR comments** — Split review comments into file-level and inline categories
- **Complexity-based thinking floor** — Minimum thinking level enforced based on task complexity classification
- **Terminal session memory** — Save terminal sessions to the Graphiti memory system

### 🛠️ Improvements
- Convert spec pipeline reports from JSON to Markdown format
- Remove file-level findings heading prefix from review body
- Replace auto-download with GitHub release link for updates
- Redirect task terminal buttons to agent terminals
- Kanban board performance optimization (debug guards, stat-based change detection, file watcher caching)
- Move activity center above Claude Code status badge
- Wire complexity passthrough from frontend to backend CLI
- Add terminal_session, qa_result, historical_context memory types
- Sync complexity classification when agent profile changes

### 🐛 Bug Fixes
- Fix Claude button reappearance after exit (split exit patterns into definitive and shell prompt arrays)
- Fix stale findings and approve buttons after review
- Fix auth terminal stuck after login (ANSI stripping, idle output fallback, profile cleanup)
- Fix full-screen terminal blocking other projects (stale expandedTerminalId)
- Fix missing setters in useTaskDetail hook
- Fix PR filter bar text cutoff (flex-wrap layout)
- Fix task timestamp fallback logic (createdAt/updatedAt cross-field)
- Fix Claude session notification bugs
- Fix memory type bugs and enable terminal sessions
- Fix stuck subtasks after rebase from main
- Fix duplicate notification push in activity center
- Fix browser-mock missing Activity Center API methods

---

## 1.0.6 - Multi-Agent Improvements & UI Polish

### ✨ New Features
- **PR-style code diff review** — Full-screen diff viewer with inline commenting, file tree, and keyboard navigation
- **Desktop notifications for PR reviews** — Get notified when PR reviews complete
- **Terminal activity indicators** — Amber dot alerts for background terminal activity
- **Coding critic agent** — Optional critic pass after subtask implementation
- **Global MCP server defaults** — Configure MCP servers globally with per-project overrides
- **Ultrathink mode** — Max thinking level toggle per agent phase
- **YOLO Max mode** — One-click toggle with rainbow effect
- **Terminal context menu** — Copy, paste, select all, and clear via right-click
- **Project tab grouping** — Drag-and-drop tab groups with color coding
- **Chrome-style tab compression** — Tabs shrink gracefully instead of overflowing

### 🐛 Bug Fixes
- Fix 3-way merge for modified files preventing silent overwrites
- Fix merge preview falsely showing "Ready to merge" when conflicts exist
- Fix remote session detection by scanning process tree
- Fix usage meter to show token count for unlimited API keys
- Fix memory card expansion rendering error (React Error #31)
- Fix terminal header close button overflow
- Fix diff viewer add comment button clipping
- Fix tooltip clipping in files tab
- Fix task terminal Claude auto-launch race condition

### 🛠️ Improvements
- Auto-stash uncommitted changes before merge
- Persist API key usage data across restarts
- Persist sidebar view per project
- Pin Python dependencies with lock file and hash verification
- Fade transitions when switching sidebar views
- Resizable diff viewer divider
- Reactive worktree sync polling
- Terminal session recovery scoped to project

---

## 1.0.5 - Tab Color Coding

### ✨ New Features
- **Project tab color coding** — Right-click any project tab to assign a color, making it easy to visually distinguish between projects. Colors persist across sessions and tint the drag overlay during reordering.

### 🛠️ Improvements
- Initial open-source release of Auto Claude (LI)

---

## 1.0.2

### Improvements

- Remove auto-switch terminal tab behavior for cleaner UX
- Remove overall review comment body and branding from PR findings
- Add agent teams support to QA review and planning phases
- Add auto-release macOS workflow with macos-latest runner

## 1.0.0

Initial release of the personal fork, based on [AndyMik90/Auto-Claude](https://github.com/AndyMik90/Auto-Claude) v2.7.6.

### What's Changed from Upstream

- **Rebranded identity** - In-app display name updated to "Auto Claude (LI)" with brand blue theme
- **Repository relocated** - GitHub owner/repo references point to `heng-l1/Auto-Claude`
- **Auto-updater reconfigured** - Update checks and downloads target the fork repository
- **Version reset to 1.0.0** - Clean versioning starting point across root package.json, frontend package.json, and backend `__init__.py`
- **Developer documentation** - README rewritten with comprehensive setup, build, test, and release instructions
- **Node version pinning** - Added `.nvmrc` for consistent Node.js 24 usage via `nvm use`
- **GitHub Actions CI/CD** - Added `prepare-release.yml` and `release.yml` workflows for automated tagging and multi-platform release builds
- **Release scripts updated** - `bump-version.js`, `update-readme.py`, and `RELEASE.md` aligned with new fork identity
- **Changelog reset** - Fresh changelog for the fork's own release history
