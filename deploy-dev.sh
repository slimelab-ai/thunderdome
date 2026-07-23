#!/bin/sh
set -eu

repo=/home/patrick/projects/thunderdome-dev
cd "$repo"

git fetch origin --prune
branch=dev
remote_sha=$(git rev-parse "origin/$branch")
deployed_sha=$(cat .deployed-dev-sha 2>/dev/null || true)
if [ "$remote_sha" = "$deployed_sha" ] && docker inspect thunderdome_dev_app >/dev/null 2>&1; then
    exit 0
fi

git checkout -B "$branch" "origin/$branch"
git restore --source "origin/$branch" --staged --worktree -- .
export VITE_BUILD_SHA="$remote_sha"
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d
printf '%s\n' "$remote_sha" > .deployed-dev-sha
