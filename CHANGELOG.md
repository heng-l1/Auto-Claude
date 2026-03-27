# Changelog

All notable changes to Auto Claude will be documented in this file.

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
