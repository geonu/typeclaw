#!/usr/bin/env bash
# Acceptance check for the --ro-bind-data file-mask contract (appendMasks in
# src/sandbox/build.ts). Not a unit test: it needs the bubblewrap that actually
# ships in the base image, which the macOS dev host cannot provide and which
# `ubuntu-latest` does not match — so the bwrap-gated unit test silently skips
# on every CI runner we have.
#
# Why it exists: bwrap copies a --ro-bind-data operand out of its fd and then
# close()s it, so each mask needs its OWN fd. Sharing one appeared to work on
# bubblewrap <= 0.11.0 (the next mkstemp reclaimed the just-freed slot and
# copied the empty temp file onto itself) and hard-fails on 0.12.0 with
# "Can't write data to file <dest>: Bad file descriptor" — which aborts the
# WHOLE bwrap invocation, not just the mask, taking down every sandboxed bash
# call down to `echo`. That shipped in 0.48.8.
#
# `bubblewrap` is installed unpinned (BASELINE_APT_PACKAGES), so this behaviour
# can change under us on any base-image rebuild with no typeclaw commit. Wired
# into release.yml's merge-base job, which runs before the irreversible npm
# publish, so a bwrap that rejects our rendered command blocks the release.
#
# Asserts only the property we depend on — N masks over N distinct fds succeed
# and every target reads back empty. It deliberately does NOT assert that a
# SHARED fd fails: that pins upstream behaviour we neither control nor need.
#
# Usage: scripts/verify-mask-fd-sandbox.sh [image] [platform]
#   image    defaults to ghcr.io/typeclaw/typeclaw-base:<version-from-package.json>
#   platform e.g. linux/amd64; defaults to the daemon's native platform
set -euo pipefail

IMAGE="${1:-}"
PLATFORM="${2:-}"
# production | diagnostic. They answer DIFFERENT questions and the release runs
# both, because one lane alone is misleading in each direction:
#   production  - can bwrap run at all under the flags an agent container gets?
#                 Authoritative. A failure here means the model bash surface is
#                 dead on this host, which is the outage this gate exists to stop.
#   diagnostic  - is the --ro-bind-data mask/fd contract still honoured by the
#                 shipped bwrap? Runs with AppArmor lifted so it can reach the
#                 masks even where host policy blocks bwrap outright. It can
#                 NEVER authorize a release on its own; it only distinguishes
#                 "the mask argv regressed" from "this host forbids bwrap".
MODE="${3:-production}"
APPARMOR_PROFILE="${TYPECLAW_APPARMOR_PROFILE:-unconfined}"
if [ -z "$IMAGE" ]; then
  version="$(node -p "require('./package.json').version" 2>/dev/null || echo latest)"
  IMAGE="ghcr.io/typeclaw/typeclaw-base:${version}"
fi
case "$MODE" in
  production | diagnostic) ;;
  *)
    echo "unknown mode: $MODE (expected 'production' or 'diagnostic')" >&2
    exit 2
    ;;
esac

# Mirrors CANONICAL_AGENT_SECRET_FILES + CANONICAL_AGENT_RUNTIME_PRIVATE_FILES.
# The count is what matters here (one fd per mask); keep in sync if that grows.
runner='
set -u
# Production hands the agent a non-root UID with an EMPTY capability set:
# `setpriv --reuid --regid --clear-groups --bounding-set=-all --inh-caps=-all
# --ambient-caps=-all` in buildEntrypointShim() (src/init/dockerfile.ts). The
# published base image carries no ENTRYPOINT, so this container never replays
# that handoff — the flags below stand in for it, and these assertions are what
# stop the gate from certifying a root/full-bounding-set shape production never
# runs. Fail before bwrap so a privilege regression is never mistaken for a
# bwrap verdict either way.
uid="$(id -u)"
gid="$(id -g)"
if [ "$uid" != 1001 ] || [ "$gid" != 1001 ]; then
  echo "PRIVILEGE_UNEXPECTED: uid=$uid gid=$gid (expected 1001:1001)"
  exit 1
fi
seen=0
while read -r field value; do
  case "$field" in
    CapInh: | CapPrm: | CapEff: | CapBnd: | CapAmb:)
      seen=$((seen + 1))
      if [ "$value" != 0000000000000000 ]; then
        echo "PRIVILEGE_CAPS_PRESENT: $field $value (expected 0000000000000000)"
        exit 1
      fi
      ;;
  esac
done < /proc/self/status
if [ "$seen" -ne 5 ]; then
  echo "PRIVILEGE_CAPS_UNREADABLE: found $seen of 5 capability masks in /proc/self/status"
  exit 1
fi
echo "PRIVILEGE_OK: uid=$uid gid=$gid, all five capability masks empty"

d=/tmp/maskcheck
mkdir -p "$d"
for f in env secrets.json auth.json incidents.json; do printf CANARY > "$d/$f"; done

# The argv shape mirrors buildArgv()/appendMasks() in src/sandbox/build.ts:
# masks render after the broad parent bind, and the rendered commandString
# self-opens one /dev/null fd per masked file. `--share-net` is part of that
# shape — production sets network:'inherit' (src/agent/plugin-tools.ts), which
# build.ts turns into --share-net, so omitting it made bwrap bring up a loopback
# production never asks it to and failed for a reason production cannot hit.
# Keep in sync if that changes.
set +e
out="$(bwrap --unshare-all --share-net \
      --new-session --die-with-parent --clearenv \
      --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp --setenv LANG C.UTF-8 \
      --ro-bind /usr /usr --ro-bind /etc /etc --dev /dev --tmpfs /tmp \
      --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
      --bind "$d" "$d" \
      --ro-bind-data 3 "$d/env" \
      --ro-bind-data 4 "$d/secrets.json" \
      --ro-bind-data 5 "$d/auth.json" \
      --ro-bind-data 6 "$d/incidents.json" \
      bash -c "cat $d/env $d/secrets.json $d/auth.json $d/incidents.json" \
      3</dev/null 4</dev/null 5</dev/null 6</dev/null 2>/tmp/maskcheck.err)"
rc=$?
set -e

echo "bwrap: $(bwrap --version)"
if [ $rc -ne 0 ]; then
  echo "MASK_BWRAP_FAILED rc=$rc"
  cat /tmp/maskcheck.err
  exit 1
fi
if [ -n "$out" ]; then
  echo "MASK_LEAKED: masked files were readable: [$out]"
  exit 1
fi
echo "MASK_CONTRACT_OK: 4 masks over 4 distinct fds, all empty"
'

echo "Image: $IMAGE${PLATFORM:+ ($PLATFORM)}"

# --pull=always plus an explicit platform, because the caller may have pulled
# several architectures under this one tag. The classic Docker image store maps
# a tag to exactly ONE image, so a preceding `docker pull --platform linux/amd64`
# followed by `--platform linux/arm64` leaves the tag on whichever came LAST.
# An unqualified `docker run` would then execute a foreign-arch image — and with
# no QEMU registered that dies on exec format, failing the release for a reason
# that has nothing to do with bwrap. Re-resolving the tag here keeps the check
# honest on both the classic and containerd image stores.
# seccomp=unconfined plus the configured AppArmor profile are what agent
# containers actually get (`runArgs` in src/container/start.ts), so production
# mirrors both. TYPECLAW_APPARMOR_PROFILE lets release CI select the shipped,
# host-loaded profile exactly as an Ubuntu operator does; it defaults to the
# product default, unconfined. Diagnostic always uses apparmor=unconfined after
# the caller has explicitly relaxed the host sysctl.
#
# Measured on Ubuntu 24.04: docker-default denies bwrap's opening
# mount(NULL, "/", MS_SLAVE|MS_REC), while apparmor=unconfined reaches Ubuntu's
# unprivileged_userns catch-all and loses the uid_map write at the stock sysctl
# value of 1. The shipped typeclaw-bwrap profile is the supported production
# path on that host; never make this lane green by relaxing the sysctl first.
#
# Anything beyond these production flags (NET_ADMIN, --privileged, or
# SYS_ADMIN) is unnecessary; SYS_ADMIN is also empty after the production
# entrypoint drops to a non-root UID, so do not add it here.
#
# --user/--cap-drop stand in for that entrypoint handoff, which this image
# cannot replay (no ENTRYPOINT in the published base). 1001:1001 is hardcoded
# rather than taken from `id -u`: a root or self-hosted runner would otherwise
# silently downgrade the gate to the root posture it exists to reject. The UID
# has no passwd entry in the base image, so HOME is set explicitly — without it
# bash falls back to `/` and the failure reads like a bwrap fault. Both lanes
# get this: the lanes differ only in AppArmor/sysctl treatment, never privilege.
run_args=(--rm --pull=always --user 1001:1001 --cap-drop ALL -e HOME=/tmp --security-opt seccomp=unconfined)
if [ "$MODE" = diagnostic ]; then
  run_args+=(--security-opt apparmor=unconfined)
else
  run_args+=(--security-opt "apparmor=$APPARMOR_PROFILE")
fi
if [ -n "$PLATFORM" ]; then
  run_args+=(--platform "$PLATFORM")
fi

docker run "${run_args[@]}" "$IMAGE" bash -c "$runner"
