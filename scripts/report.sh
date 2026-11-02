#!/usr/bin/env bash
# Publish a short live status to the repo variable STATUS so it can be read
# from outside while the job is still running.
set -uo pipefail
[ -z "${GH_TOKEN:-}" ] && exit 0
[ -z "${GITHUB_REPOSITORY:-}" ] && exit 0
host="${GITHUB_API_URL:-https://api.github.com}"
printf '%s' "$1" | python3 -c '
import json, sys
print(json.dumps({"name": "STATUS", "value": sys.stdin.read()[:12000]}))
' > /tmp/status.json 2>/dev/null || exit 0
curl -s -o /dev/null -X PATCH \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "$host/repos/$GITHUB_REPOSITORY/actions/variables/STATUS" \
  --data @/tmp/status.json
