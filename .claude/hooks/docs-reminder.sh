#!/usr/bin/env bash
# PreToolUse hook (git commit): non-blocking reminder to keep docs in sync with code.
# Fires only via the settings `if: Bash(git commit*)` filter. If staged changes touch lib/ but no
# docs (README.md / CLAUDE.md / AGENTS.md / docs/), surface a reminder and still allow the commit.
staged="$(git diff --cached --name-only 2>/dev/null)"
code="$(printf '%s\n' "$staged" | grep -E '^lib/' || true)"
docs="$(printf '%s\n' "$staged" | grep -E '^(README\.md|CLAUDE\.md|AGENTS\.md|docs/)' || true)"
if [ -n "$code" ] && [ -z "$docs" ]; then
  cat <<'JSON'
{"systemMessage":"⚠ Docs reminder: staged lib/ changes with no doc updates (README/CLAUDE/AGENTS/docs). Confirm docs are current before/with this commit.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"This commit stages lib/ code but no docs. Project policy (docs-sync-every-commit): update README, docs/ARCHITECTURE.md, docs/CONTROLS.md, runbooks, and build-plan status in the SAME commit when the change affects them."}}
JSON
fi
exit 0
