#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

secret_pattern='(^|/)(\.env(\..*)?|\.npmrc|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519))$'
secret_allow_pattern='(^|/)\.env\.(example|sample|template)$'
secret_content_pattern='(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'

# Prints secret-looking paths from stdin, excluding documented templates.
list_secret_files() {
    grep -E "$secret_pattern" | grep -Ev "$secret_allow_pattern" || true
}

git status

# Refuse to commit credentials if any are present in the working tree.
if {
    git diff --name-only
    git ls-files --others --exclude-standard
} | list_secret_files | grep -q .; then
    echo "Refusing to commit: potential secret files detected in the working tree." >&2
    {
        git diff --name-only
        git ls-files --others --exclude-standard
    } | list_secret_files >&2
    exit 1
fi

git add -A

# Check again after staging (catches files force-added or already tracked).
if git diff --cached --name-only | list_secret_files | grep -q .; then
    echo "Refusing to commit: potential secret files are staged." >&2
    git diff --cached --name-only | list_secret_files >&2
    git reset --quiet
    exit 1
fi

# Scan the *contents* of staged files, not just their names. A token pasted
# into a normal source file would otherwise be committed unnoticed.
if matches=$(git grep --cached -I -n -E "$secret_content_pattern" -- .); then
    echo "Refusing to commit: potential secrets detected in staged file contents." >&2
    echo "$matches" >&2
    git reset --quiet
    exit 1
fi

git commit -m "Update"
git push
