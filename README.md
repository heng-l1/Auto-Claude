# Auto Claude (LI)

An autonomous multi-agent coding framework powered by Claude AI. Based on [Auto Claude](https://github.com/AndyMik90/Auto-Claude) by Andre Mikalsen.

[![License](https://img.shields.io/badge/license-AGPL--3.0-green?style=flat-square)](./agpl-3.0.txt)
[![CI](https://img.shields.io/github/actions/workflow/status/heng-l1/Auto-Claude/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/heng-l1/Auto-Claude/actions)
[![Security](https://github.com/heng-l1/Auto-Claude/actions/workflows/security.yml/badge.svg)](https://github.com/heng-l1/Auto-Claude/actions/workflows/security.yml)

- MCP health check and test connection UI
- Kanban board layout and card padding fixes
- Secret scanning compliance

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Development](#development)
- [Building](#building)
- [Testing](#testing)
- [Packaging](#packaging)
- [Release](#release)
- [Project Structure](#project-structure)
- [Features](#features)
- [CLI Usage](#cli-usage)
- [Security](#security)
- [License](#license)

---

## Prerequisites

Before getting started, ensure you have the following installed:

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | 24+ | Electron frontend and build tooling |
| **nvm** | latest | Node version management (recommended) |
| **npm** | 10+ | Package manager (bundled with Node.js) |
| **Python** | 3.12+ | Backend agent framework |
| **uv** or **pip** | latest | Python package manager |
| **Git** | 2.20+ | Version control and worktree isolation |
| **CMake** | latest | Building native dependencies |

### Installing nvm

**macOS / Linux:**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

**Windows:**

Use [nvm-windows](https://github.com/coreybutler/nvm-windows/releases) and follow the installer.

### Installing Python 3.12

**macOS:**
```bash
brew install python@3.12
```

**Ubuntu / Debian:**
```bash
sudo apt install python3.12 python3.12-venv
```

**Windows:**
```bash
winget install Python.Python.3.12
```

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/heng-l1/Auto-Claude.git
cd Auto-Claude

# 2. Install and use the correct Node.js version
nvm install
nvm use

# 3. Install all dependencies (backend + frontend)
npm run install:all

# 4. Start in development mode
npm run dev
```

The `nvm install` command reads the `.nvmrc` file and installs Node.js 24. The `nvm use` command activates it for your current shell.

`npm run install:all` will:
- Detect Python 3.12+ on your system
- Create a virtual environment at `apps/backend/.venv`
- Install backend runtime and test dependencies from `requirements.lock` (pinned, secure versions)
- Copy `.env.example` to `.env` if not already present
- Install frontend npm dependencies

---

## Development

### Running the App

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Electron in development mode with hot reload |
| `npm run dev:debug` | Development mode with verbose debug output |
| `npm run dev:mcp` | Development mode with Electron MCP server for AI debugging |
| `npm start` | Build production frontend, then launch the app |

### Backend CLI

The backend can also run standalone without the Electron UI:

```bash
cd apps/backend

# Create a spec interactively
python spec_runner.py --interactive

# Run an autonomous build
python run.py --spec 001

# Review and merge
python run.py --spec 001 --review
python run.py --spec 001 --merge
```

See [guides/CLI-USAGE.md](guides/CLI-USAGE.md) for complete CLI documentation.

### Environment Configuration

After installing, configure your credentials in `apps/backend/.env`:

```bash
# Get your Claude Code OAuth token
claude setup-token

# Then edit apps/backend/.env with your token
```

### Available Scripts

All scripts can be run from the repository root:

| Command | Description |
|---------|-------------|
| `npm run install:all` | Install backend and frontend dependencies |
| `npm run lockfile:sync` | Regenerate Python lock file after editing requirements.txt |
| `npm run dev` | Development mode with hot reload |
| `npm run dev:debug` | Development mode with debug output |
| `npm start` | Build and run the desktop app |
| `npm run build` | Build the frontend for production |
| `npm run lint` | Run Biome linter on frontend |
| `npm test` | Run frontend unit tests (Vitest) |
| `npm run test:backend` | Run backend tests (pytest) |
| `npm run package` | Package for current platform |
| `npm run package:mac` | Package for macOS |
| `npm run package:win` | Package for Windows |
| `npm run package:linux` | Package for Linux |

---

## Building

### Frontend Build

```bash
# Build the Electron frontend for production
npm run build

# Or from the frontend directory
cd apps/frontend && npm run build
```

This uses `electron-vite` to compile the main process, preload scripts, and renderer (React) into the `apps/frontend/out/` directory.

### Backend Setup

The backend does not have a separate build step. It runs directly from Python source:

```bash
cd apps/backend

# Create a virtual environment (if not done by install:all)
uv venv
uv pip install -r requirements.lock

# Or with pip
python -m venv .venv
source .venv/bin/activate  # macOS/Linux
# .venv\Scriptsctivate   # Windows
pip install -r requirements.lock
```

### Managing Python Dependencies

The backend uses a **lock file workflow** for secure, reproducible dependency management:

- **`requirements.txt`** - Human-editable list of direct dependencies
- **`requirements.lock`** - Auto-generated pinned versions with SHA256 hashes (committed to git)

#### Why Lock Files?

1. **Security** - SHA256 hashes prevent supply-chain attacks and malicious package replacements
2. **Reproducibility** - Exact versions ensure consistent builds across all environments
3. **Audit Trail** - Git history shows precisely what changed in dependencies

#### Dependency Workflow

When you need to add, update, or remove a Python dependency:

```bash
# 1. Edit requirements.txt manually
# Add, remove, or update dependencies

# 2. Regenerate the lock file
npm run lockfile:sync

# 3. Commit BOTH files together
git add apps/backend/requirements.txt apps/backend/requirements.lock
git commit -m "Update Python dependencies: <description>"
```

**Important:** Always commit `requirements.txt` and `requirements.lock` together. The lock file is not gitignored—it's a first-class artifact that ensures secure installs.

#### Updating for Security

To pull in the latest security patches for all dependencies:

```bash
cd apps/backend

# Regenerate lock with latest versions within constraints
npm run lockfile:sync

# Review changes
git diff requirements.lock

# Commit if satisfied
git add requirements.lock
git commit -m "Update Python dependencies for security patches"
```

---

## Testing

### Backend Tests (pytest)

```bash
# From repository root
npm run test:backend

# Or directly with pytest
cd apps/backend
.venv/bin/pytest ../tests -v                      # macOS/Linux
.venv/Scripts/pytest.exe ../tests -v              # Windows

# Run a specific test file
npm run test:backend -- tests/test_security.py -v

# Run with coverage
npm run test:coverage
```

### Frontend Unit Tests (Vitest)

```bash
cd apps/frontend

# Run all unit tests
npm test

# Run in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage

# Type checking
npm run typecheck

# Linting
npm run lint
```

### End-to-End Tests (Playwright)

```bash
cd apps/frontend

# Build first (E2E tests require a built app)
npm run build

# Run E2E tests
npm run test:e2e
```

### Test Summary

| Stack | Command | Framework |
|-------|---------|-----------|
| Backend | `npm run test:backend` | pytest |
| Frontend unit | `cd apps/frontend && npm test` | Vitest |
| Frontend E2E | `cd apps/frontend && npm run test:e2e` | Playwright |
| Frontend lint | `cd apps/frontend && npm run lint` | Biome |
| Type check | `cd apps/frontend && npm run typecheck` | TypeScript |

---

## Packaging

Package the app for distribution on your current platform:

```bash
# Auto-detect current platform
npm run package

# Or target a specific platform
npm run package:mac       # macOS (DMG + ZIP)
npm run package:win       # Windows (NSIS installer + ZIP)
npm run package:linux     # Linux (AppImage + .deb + Flatpak)
```

Packaged artifacts are output to `apps/frontend/dist/`.

For Flatpak-specific builds and Linux packaging details, see [guides/linux.md](guides/linux.md).

> **Note:** Code signing and notarization are not configured. Packaged builds will be unsigned.

---

## Release

Auto Claude uses an automated release pipeline via GitHub Actions. See [RELEASE.md](RELEASE.md) for the full process.

### Quick Release Steps

1. **Bump the version** on your development branch:

   ```bash
   node scripts/bump-version.js patch   # Bug fix: 1.0.0 -> 1.0.1
   node scripts/bump-version.js minor   # Feature: 1.0.0 -> 1.1.0
   node scripts/bump-version.js major   # Breaking: 1.0.0 -> 2.0.0
   ```

2. **Update CHANGELOG.md** with release notes (required - the release will fail without it).

3. **Push and create a PR** to `main`:

   ```bash
   git push origin your-branch
   gh pr create --base main --title "Release v1.1.0"
   ```

4. **Merge to main** - GitHub Actions will automatically:
   - Detect the version bump
   - Validate the changelog entry
   - Create a git tag
   - Build binaries for all platforms
   - Publish a GitHub release

### Version Locations

The version is stored in three places and must stay in sync:

| File | Field |
|------|-------|
| `package.json` | `"version"` |
| `apps/frontend/package.json` | `"version"` |
| `apps/backend/__init__.py` | `__version__` |

The `scripts/bump-version.js` script updates all three automatically.

---

## Project Structure

```
auto-claude/
├── apps/
│   ├── backend/              # Python backend - agent logic, CLI
│   │   ├── core/             # Client, auth, worktree, platform
│   │   ├── agents/           # Planner, coder, session management
│   │   ├── qa/               # QA reviewer, fixer, loop
│   │   ├── spec/             # Spec creation pipeline
│   │   ├── cli/              # CLI commands
│   │   ├── runners/          # Standalone runners (spec, roadmap, insights)
│   │   └── prompts/          # Agent system prompts (.md)
│   └── frontend/             # Electron + React desktop UI
│       └── src/
│           ├── main/          # Electron main process
│           ├── preload/       # Preload scripts (IPC bridge)
│           ├── renderer/      # React UI (components, stores, hooks)
│           └── shared/        # Types, i18n, constants, utils
├── guides/                   # Additional documentation
├── tests/                    # Backend test suite
├── scripts/                  # Build and release utilities
├── .github/workflows/        # CI/CD pipelines
└── .nvmrc                    # Node.js version pin (for nvm)
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Autonomous Tasks** | Describe your goal; agents handle planning, implementation, and validation |
| **Parallel Execution** | Run multiple builds simultaneously with up to 12 agent terminals |
| **Isolated Workspaces** | All changes happen in git worktrees - your main branch stays safe |
| **Self-Validating QA** | Built-in quality assurance loop catches issues before you review |
| **AI-Powered Merge** | Automatic conflict resolution when integrating back to main |
| **Memory Layer** | Agents retain insights across sessions for smarter builds |
| **GitHub/GitLab Integration** | Import issues, investigate with AI, create merge requests |
| **Cross-Platform** | Native desktop apps for Windows, macOS, and Linux |
| **Auto-Updates** | App updates automatically when new versions are released |

---

## CLI Usage

For headless operation, CI/CD integration, or terminal-only workflows:

```bash
cd apps/backend

# Create a spec interactively
python spec_runner.py --interactive

# Run autonomous build
python run.py --spec 001

# Review and merge
python run.py --spec 001 --review
python run.py --spec 001 --merge
```

See [guides/CLI-USAGE.md](guides/CLI-USAGE.md) for complete CLI documentation.

---

## Security

Auto Claude uses a three-layer security model:

1. **OS Sandbox** - Bash commands run in isolation
2. **Filesystem Restrictions** - Operations limited to project directory
3. **Dynamic Command Allowlist** - Only approved commands based on detected project stack

### Automated Security Scanning

The project includes automated security scanning that runs on every pull request and main branch commit:

- **Dependency Auditing** - Scans for known vulnerabilities in npm and Python dependencies
- **Secret Scanning** - Detects accidentally committed secrets and credentials
- **SAST Analysis** - Static analysis for security issues in TypeScript and Python code
- **License Compliance** - Verifies all dependencies comply with AGPL-3.0

Security scan results are available in the [GitHub Actions security workflow](https://github.com/heng-l1/Auto-Claude/actions/workflows/security.yml).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style guidelines, testing requirements, and pull request process.

For Linux-specific builds (Flatpak, AppImage), see [guides/linux.md](guides/linux.md).

For Windows development notes, see [guides/windows-development.md](guides/windows-development.md).

---

## License

**AGPL-3.0** - GNU Affero General Public License v3.0

This project is free to use. If you modify and distribute it, or run it as a service, your code must also be open source under AGPL-3.0.

---

*Based on [Auto-Claude](https://github.com/AndyMik90/Auto-Claude) by Andre Mikalsen. Licensed under AGPL-3.0.*
