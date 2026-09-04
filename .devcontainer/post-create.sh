#!/bin/sh
# One-way sync the host's GPG keys into the container-local ~/.gnupg.
#
# Runs as the devcontainer postCreateCommand. The host ~/.gnupg is staged
# read-only at /root/.gnupg-host (see devcontainer.json). GPG daemons must
# not run against that live dir: POSIX locks pass through the bind mount and
# the host's GPG Suite holds them. Copying gives the container's gpg its own
# private state (locks, sockets, agent).

set -e

rm -rf /root/.gnupg

# Sockets in the staged dir cannot be copied and are not needed; ignore.
cp -a /root/.gnupg-host/. /root/.gnupg/ 2>/dev/null || true

# Drop lock files copied from the host: they reference host pids and would
# make the container's gpg wait on locks it can never observe.
find /root/.gnupg -name '*.lock' -delete
find /root/.gnupg -name '.#*' -delete
rm -rf /root/.gnupg/S.*
chmod -R 700 /root/.gnupg
