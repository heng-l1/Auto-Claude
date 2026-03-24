# Changelog

All notable changes to Auto Claude will be documented in this file.

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
