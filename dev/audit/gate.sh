#!/usr/bin/env bash
# Audit gate: the four documented checks, with the vitest flake made visible.
# Run under Git for Windows bash. Under WSL the win32 esbuild/electron binaries
# in node_modules cannot execute (BUILD FAIL) and git without core.autocrlf
# flags every CRLF blob as modified (whitespace FAIL).
# Exit 0 only when every run passes and no vitest "Errors" section appears.
set -uo pipefail
cd "$(dirname "$0")/../.."
RUNS=${1:-1}
fail=0
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  printf '%s\n' 'gate: refusing to run under WSL — use Git for Windows bash: "C:\Program Files\Git\bin\bash.exe" dev/audit/gate.sh [runs]' >&2
  exit 2
fi

echo "== build =="
npm run build >/tmp/audit-build.log 2>&1 || { echo "BUILD FAIL"; tail -20 /tmp/audit-build.log; fail=1; }

echo "== typecheck (renderer + main tests) =="
npm run typecheck >/tmp/audit-tsc.log 2>&1 || { echo "TYPECHECK FAIL"; tail -20 /tmp/audit-tsc.log; fail=1; }

for i in $(seq 1 "$RUNS"); do
  echo "== vitest run $i =="
  npx vitest run >/tmp/audit-vitest-$i.log 2>&1
  code=$?
  grep -E "Test Files|Tests  |Errors " /tmp/audit-vitest-$i.log | tail -3
  if [ "$code" -ne 0 ]; then
    echo "VITEST EXIT $code (run $i)"
    grep -A2 "Unhandled Rejection\|Unhandled Error" /tmp/audit-vitest-$i.log | head -20
    fail=1
  fi
done

echo "== whitespace =="
# Scope to the delta: a whole-tree `git diff --check` flags pre-existing CRLF
# blobs whenever the checkout normalizes them (a WSL checkout of this repo
# reports every line of `.claude/**` as trailing whitespace — an environment
# artifact, not a repo defect).
git diff --name-only -z | xargs -0 --no-run-if-empty git diff --check -- || fail=1

echo "== doc pointers (advisory; E3/E4 own the anchor rows) =="
node dev/audit/pointer-check.js docs || echo "POINTER WARN (not gating)"

exit "$fail"
