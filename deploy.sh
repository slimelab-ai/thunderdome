#!/bin/sh
set -eu

repo=/home/patrick/projects/thunderdome
cd "$repo"

git fetch origin --prune
branch=main

remote_sha=$(git rev-parse "origin/$branch")
deployed_sha=$(cat .deployed-sha 2>/dev/null || true)
if [ "$remote_sha" = "$deployed_sha" ] && docker inspect thunderdome_app >/dev/null 2>&1; then
    exit 0
fi

git checkout -B "$branch" "origin/$branch"
git restore --source "origin/$branch" --staged --worktree -- .
docker compose build app
docker compose up -d
printf '%s\n' "$remote_sha" > .deployed-sha
