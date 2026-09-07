#!/usr/bin/env bash
# Acceptance check for signal delivery under the shipped AppArmor profile
# (scripts/apparmor/typeclaw-bwrap). Companion to verify-mask-fd-sandbox.sh,
# which only proves bwrap can START — its sandboxed command exits naturally, so
# it covers neither of the two paths that need a signal to cross the profile:
#
#   1. Cancellation. The agent kills its own sandboxed bash on timeout/abort.
#      Every process in the container carries the container profile, bwrap
#      children included, so that is a SAME-PROFILE send and needs an explicit
#      `signal (send,receive) peer=typeclaw-bwrap`.
#   2. Lifecycle. `typeclaw stop`/`restart` are `docker stop`/`docker restart`
#      (src/container/start.ts), whose SIGTERM originates outside the profile —
#      from an unconfined dockerd, or from `runc kill` where the OCI runtime
#      itself is confined on Ubuntu 23.10+. That needs `signal (receive)` rules
#      naming those peers.
#
# Both failures are silent-ish in production: a denied cancellation leaves a
# runaway sandbox, and a denied SIGTERM turns every stop into a 10s wait for
# dockerd's SIGKILL. Neither shows up as a bwrap error, which is why this runs
# as its own release gate rather than as an extra assertion in the mask lane.
#
# The container is deliberately NOT run with --rm: the stop/start/restart legs
# need its filesystem (and the counters below) to survive exit.
#
# Usage: scripts/verify-apparmor-signals.sh [image] [platform]
#   image    defaults to ghcr.io/typeclaw/typeclaw-base:<version-from-package.json>
#   platform e.g. linux/amd64; defaults to the daemon's native platform
#   TYPECLAW_APPARMOR_PROFILE selects the profile, defaulting to the product
#   default (unconfined) so a plain local run still exercises the script.
set -euo pipefail

IMAGE="${1:-}"
PLATFORM="${2:-}"
APPARMOR_PROFILE="${TYPECLAW_APPARMOR_PROFILE:-unconfined}"
STOP_GRACE=5
if [ -z "$IMAGE" ]; then
  version="$(node -p "require('./package.json').version" 2>/dev/null || echo latest)"
  IMAGE="ghcr.io/typeclaw/typeclaw-base:${version}"
fi

NAME="typeclaw-signal-check-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# PID 1 counts the SIGTERMs it actually handled, in a file that outlives each
# container exit. A counter — not `docker inspect`'s exit code — is the oracle:
# a PID 1 relying on SIGTERM's DEFAULT disposition dies identically whether the
# signal arrived or dockerd's post-grace SIGKILL did, and `--init` rewrites the
# propagated status anyway. Only an installed handler proves receipt.
#
# `boots` is the readiness marker and is bumped AFTER the trap is installed, so
# the caller can never observe a container that is up but not yet trap-armed —
# and, unlike a `ready` file, it cannot be confused with a stale one left behind
# by the previous run's filesystem.
read -r -d '' PID1_PAYLOAD <<'PAYLOAD' || true
set -u
state=/tmp/typeclaw-signal-state
mkdir -p "$state"
[ -f "$state/terms" ] || printf '0\n' > "$state/terms"
trap 'printf "%s\n" "$(( $(cat "$state/terms") + 1 ))" > "$state/terms"; exit 0' TERM
printf '%s\n' "$(( $(cat "$state/boots" 2>/dev/null || echo 0) + 1 ))" > "$state/boots"
while :; do
  sleep 0.2 &
  wait "$!"
done
PAYLOAD

# Mirrors the sandbox shape verify-mask-fd-sandbox.sh renders (buildArgv() in
# src/sandbox/build.ts) minus the masks, which are not what is under test here.
# An AppArmor signal denial surfaces as EPERM from kill(2), so the send is
# checked separately from the death — otherwise a denied send and an ignored
# signal would report identically. The watchdog bounds the wait so a wedged
# sandbox fails the gate instead of hanging it.
read -r -d '' ABORT_PAYLOAD <<'PAYLOAD' || true
set -u
bwrap --unshare-all --share-net \
  --new-session --die-with-parent --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp --setenv LANG C.UTF-8 \
  --ro-bind /usr /usr --ro-bind /etc /etc --dev /dev --tmpfs /tmp \
  --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
  -- sleep 300 &
pid=$!
sleep 0.5
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid" || true
  echo "CANCEL_SANDBOX_DIED_EARLY: bwrap exited before it could be aborted"
  exit 1
fi
if ! kill -TERM "$pid" 2>/tmp/cancel.err; then
  echo "CANCEL_SEND_DENIED: kill -TERM refused: $(cat /tmp/cancel.err)"
  exit 1
fi
( sleep 5; kill -KILL "$pid" 2>/dev/null ) &
watchdog=$!
set +e
wait "$pid"
rc=$?
set -e
kill "$watchdog" 2>/dev/null || true
if [ "$rc" -ne 143 ]; then
  echo "CANCEL_NOT_DELIVERED: sandbox exited $rc, expected 143 (SIGTERM)"
  exit 1
fi
echo "CANCEL_OK: same-profile SIGTERM aborted the sandboxed command"
PAYLOAD

boots() { docker exec "$NAME" cat /tmp/typeclaw-signal-state/boots 2>/dev/null || true; }
terms() { docker exec "$NAME" cat /tmp/typeclaw-signal-state/terms 2>/dev/null || true; }

wait_for_boot() {
  local expected="$1" i=0
  while [ "$i" -lt 300 ]; do
    if [ "$(boots)" = "$expected" ]; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  echo "SIGNAL_GATE_FAILED: container did not reach boot $expected" >&2
  docker logs "$NAME" >&2 || true
  return 1
}

assert_terms() {
  local expected="$1" label="$2" actual
  actual="$(terms)"
  if [ "$actual" != "$expected" ]; then
    echo "SIGNAL_NOT_RECEIVED: $label — PID 1 handled $actual SIGTERM(s), expected $expected."
    echo "  The AppArmor profile ($APPARMOR_PROFILE) is not permitting signal receipt from"
    echo "  the daemon or OCI runtime. Add the missing 'signal (receive) peer=<label>' rule;"
    echo "  see scripts/apparmor/typeclaw-bwrap."
    exit 1
  fi
}

echo "Image: $IMAGE${PLATFORM:+ ($PLATFORM)}"
echo "AppArmor profile: $APPARMOR_PROFILE"

# --init, --user, and --cap-drop mirror the production container: `docker stop`
# reaches PID 1 through tini there too, and a root/capable payload could pass
# this gate on kill permissions the real agent process does not hold.
run_args=(-d --name "$NAME" --pull=always --init --user 1001:1001 --cap-drop ALL -e HOME=/tmp)
run_args+=(--security-opt seccomp=unconfined --security-opt "apparmor=$APPARMOR_PROFILE")
if [ -n "$PLATFORM" ]; then
  run_args+=(--platform "$PLATFORM")
fi

docker run "${run_args[@]}" "$IMAGE" bash -c "$PID1_PAYLOAD" >/dev/null
wait_for_boot 1
assert_terms 0 'fresh container'

docker exec "$NAME" bash -c "$ABORT_PAYLOAD"

docker stop --time "$STOP_GRACE" "$NAME" >/dev/null
docker start "$NAME" >/dev/null
wait_for_boot 2
assert_terms 1 'docker stop'

docker restart --time "$STOP_GRACE" "$NAME" >/dev/null
wait_for_boot 3
assert_terms 2 'docker restart'

echo "SIGNAL_CONTRACT_OK: cancellation, stop, and restart all delivered under $APPARMOR_PROFILE"
