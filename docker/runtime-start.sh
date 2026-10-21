#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu
mkdir -p "$HOME" /tmp/relay-jobs /tmp/relay-runtime
chmod 700 /tmp/relay-runtime
export XDG_RUNTIME_DIR=/tmp/relay-runtime
# No desktop service or browser profile is started here. Descendants of every
# command stay inside this container's PID namespace and freezer cgroup.
exec sleep infinity
