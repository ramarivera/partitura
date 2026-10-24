#!/bin/sh
set -eu
export PATH=/opt/partitura/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm /run /tmp /sys/fs/cgroup
mount -t devpts devpts /dev/pts
mount -t tmpfs -o mode=1777,nosuid,nodev,size=256m tmpfs /dev/shm
mount -t tmpfs -o mode=0755,nosuid,nodev,size=256m tmpfs /run
mount -t tmpfs -o mode=1777,nosuid,nodev,size=512m tmpfs /tmp
mount -t cgroup2 none /sys/fs/cgroup
mkdir -p /run/partitura-config /workspace /mise /var/lib/docker
mount -t ext4 -o ro,nosuid,nodev,noexec /dev/vdb /run/partitura-config
worker_uid=$(python3 -c 'import json; c=json.load(open("/run/partitura-config/config.json")); u=int(c["workerUid"]); assert 1 <= u <= 65535; print(u)')
echo "worker:x:$worker_uid:$worker_uid:Session worker:/workspace/.omp-home:/bin/bash" >> /etc/passwd
echo "worker:x:$worker_uid:" >> /etc/group
export PARTITURA_WORKER_UID="$worker_uid"
export MISE_DATA_DIR=/mise
export DOCKER_DATA_ROOT=/var/lib/docker
export HTTP_PROXY=http://127.0.0.1:3128
export HTTPS_PROXY=http://127.0.0.1:3128
export NO_PROXY=localhost,127.0.0.1,::1
hostname partitura-worker
ip link set lo up
/usr/local/bin/worker-init >/run/docker.log 2>&1 &
docker_pid=$!
/usr/local/bin/partitura-guest-agent &
agent_pid=$!
shutdown() {
  trap '' TERM INT HUP
  kill -TERM "$agent_pid" "$docker_pid" 2>/dev/null || true
  wait "$docker_pid" 2>/dev/null || true
  wait "$agent_pid" 2>/dev/null || true
  sync
  python3 -c 'import ctypes; ctypes.CDLL(None).reboot(0x4321fedc)'
}
trap shutdown TERM INT HUP
# PID 1 reaps daemon children. Losing either control plane or Docker ends the VM.
while kill -0 "$agent_pid" 2>/dev/null && kill -0 "$docker_pid" 2>/dev/null; do
  sleep 1 &
  wait "$!" || true
done
shutdown
