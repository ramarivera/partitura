#!/bin/sh
set -eu

data_root=${DOCKER_DATA_ROOT:-/workspace/.omp-home/docker}
worker_uid=${PARTITURA_WORKER_UID:-}
case "$worker_uid" in
  ''|*[!0-9]*) echo "PARTITURA_WORKER_UID must be numeric" >&2; exit 64 ;;
esac
if [ "$worker_uid" = "0" ]; then
  echo "PARTITURA_WORKER_UID must be non-root" >&2
  exit 64
fi
mkdir -p "$data_root" /run/docker
chown "$worker_uid:$worker_uid" "$data_root" /mise
chmod 0700 "$data_root" /mise
export DOCKER_HOST=unix:///run/docker.sock

dockerd \
  --host=unix:///run/docker.sock \
  --data-root="$data_root" \
  --exec-root=/run/docker \
  --pidfile=/run/docker.pid \
  --group=root &
daemon_pid=$!

stop_daemon() {
  kill -TERM "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
}
trap stop_daemon EXIT
trap 'exit 0' HUP INT TERM

attempt=0
until docker info >/dev/null 2>&1; do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    wait "$daemon_pid"
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "nested Docker did not become ready" >&2
    exit 1
  fi
  sleep 1
done

# This socket is visible only inside this one Sysbox container. A worker needs
# it to run Docker CLI commands; no host socket is mounted into the container.
chmod 0666 /run/docker.sock
wait "$daemon_pid"
