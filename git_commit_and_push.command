#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

secret_pattern='(^|/)(\.env(\..*)?|\.npmrc|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519))$'

git status

# Refuse to commit credentials if any are present in the working tree.
{
    git diff --name-only
    git ls-files --others --exclude-standard
} | grep -Eq "$secret_pattern" && {
    echo "Refusing to commit: potential secret files detected in the working tree." >&2
    {
        git diff --name-only
        git ls-files --others --exclude-standard
    } | grep -E "$secret_pattern" >&2
    exit 1
}

git add -A

# Check again after staging (catches files force-added or already tracked).
if git diff --cached --name-only | grep -Eq "$secret_pattern"; then
    echo "Refusing to commit: potential secret files are staged." >&2
    git diff --cached --name-only | grep -E "$secret_pattern" >&2
    git reset --quiet
    exit 1
fi

git commit -m "Update"
git push
