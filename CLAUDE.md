# provider-guard
- Read PRD.md fully before any work. Build milestone by milestone (PRD §11); tests first.
- Before any UI work, read DESIGN.md and the Geist .md pages listed in PRD §0. Geist docs win on conflicts.
- Zero runtime dependencies in packages/core. Ask before adding one.
- Never call AI Gateway endpoints that need an API key. Fixtures by default.
- Never store or display prompt or response content.
- Cross-platform scripts only; CI must pass on Windows.
- Log decisions and API discrepancies in NOTES.md.
