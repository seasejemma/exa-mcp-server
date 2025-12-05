#!/bin/bash
# ============================================================================
# Setup Private Fork with Upstream Sync
# ============================================================================
# This script sets up the branch structure for a private fork that syncs
# from upstream while maintaining customizations.
#
# Branch Structure:
#   upstream  - Clean mirror of exa-labs/exa-mcp-server (no customizations)
#   custom    - Your customizations rebased on upstream
#   main      - Production branch (Deno Deploy watches this)
#
# Usage:
#   ./scripts/setup-private-fork.sh
# ============================================================================

set -e

UPSTREAM_URL="https://github.com/exa-labs/exa-mcp-server.git"
PRIVATE_REPO="seasejemma/exa-mcp"

echo "============================================"
echo "  Private Fork Setup Script"
echo "============================================"

# Check we're in the right directory
if [ ! -f "deno.json" ]; then
    echo "❌ Error: Run this script from the repo root"
    exit 1
fi

# Check if we're in the private repo
CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
if [[ ! "$CURRENT_REMOTE" =~ "$PRIVATE_REPO" ]]; then
    echo "⚠️  Warning: Current remote doesn't match expected private repo"
    echo "   Current: $CURRENT_REMOTE"
    echo "   Expected: github.com/$PRIVATE_REPO"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

echo ""
echo "📦 Step 1: Configure remotes"
echo "-------------------------------------------"

# Add upstream if not exists
if git remote get-url upstream &>/dev/null; then
    echo "✓ upstream remote already exists"
else
    echo "Adding upstream remote..."
    git remote add upstream "$UPSTREAM_URL"
    echo "✓ Added upstream remote"
fi

# Disable push to upstream (safety)
git remote set-url --push upstream DISABLE
echo "✓ Disabled push to upstream"

echo ""
git remote -v
echo ""

echo "📦 Step 2: Create upstream branch"
echo "-------------------------------------------"

git fetch upstream main --tags

# Create upstream branch tracking upstream/main
if git show-ref --verify --quiet refs/heads/upstream; then
    echo "✓ upstream branch already exists"
    git checkout upstream
    git reset --hard upstream/main
else
    echo "Creating upstream branch..."
    git checkout -b upstream upstream/main
fi

git push -u origin upstream --force-with-lease
echo "✓ upstream branch ready"

echo ""
echo "📦 Step 3: Create custom branch"
echo "-------------------------------------------"

git checkout main

if git show-ref --verify --quiet refs/heads/custom; then
    echo "✓ custom branch already exists"
else
    echo "Creating custom branch from main..."
    git checkout -b custom
fi

git push -u origin custom --force-with-lease
echo "✓ custom branch ready"

echo ""
echo "📦 Step 4: Verify branch structure"
echo "-------------------------------------------"

git checkout main

echo ""
echo "Branches:"
git branch -a | head -20

echo ""
echo "============================================"
echo "  ✅ Setup Complete!"
echo "============================================"
echo ""
echo "Branch structure:"
echo "  upstream  → Mirrors exa-labs/exa-mcp-server"
echo "  custom    → Your customizations (rebase onto upstream)"
echo "  main      → Production (Deno Deploy watches this)"
echo ""
echo "Workflow:"
echo "  1. sync-upstream.yml runs daily at 6 AM UTC"
echo "  2. Pulls upstream changes to 'upstream' branch"
echo "  3. Rebases 'custom' onto 'upstream'"
echo "  4. Creates PR: custom → main"
echo "  5. On merge: Deno Deploy redeploys"
echo "  6. health-check.yml verifies deployment"
echo ""
echo "Manual sync:"
echo "  gh workflow run sync-upstream.yml"
echo ""
echo "Manual trigger with force:"
echo "  gh workflow run sync-upstream.yml -f force_sync=true"
echo ""
