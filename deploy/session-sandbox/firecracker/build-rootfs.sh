#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 || ! $1 =~ ^sha256:[a-f0-9]{64}$ || $2 != /* ]]; then
  echo 'usage: build-rootfs.sh sha256:<worker-image-id> /absolute/scratch/output-directory' >&2
  exit 64
fi
worker_image=$1
output=$2
rootfs_size=${PARTITURA_ROOTFS_SIZE_MIB:-12288}
if [[ ! $rootfs_size =~ ^[0-9]+$ ]] || ((rootfs_size < 4096 || rootfs_size > 32768)); then
  echo 'PARTITURA_ROOTFS_SIZE_MIB must be between 4096 and 32768' >&2
  exit 64
fi
repo=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$output"
output=$(realpath "$output")
if [[ -e "$output/rootfs.ext4" || -e "$output/rootfs.tar" || -e "$output/rootfs" ]]; then
  echo 'output directory already contains a rootfs build' >&2
  exit 64
fi
guest_tag="partitura-firecracker-guest:build-$$"
builder_tag="partitura-firecracker-rootfs:build-$$"
worker_tag="partitura-firecracker-worker:build-$$"
container=
cleanup() {
  if [[ -n $container ]]; then docker rm -f "$container" >/dev/null; fi
  docker image rm "$guest_tag" "$builder_tag" "$worker_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# BuildKit interprets a bare sha256 image ID as a repository name. A private
# temporary tag resolves the already-local, verified immutable input instead.
[[ $(docker image inspect "$worker_image" --format '{{.Id}}') == "$worker_image" ]]
docker tag "$worker_image" "$worker_tag"
docker build --build-arg "WORKER_IMAGE=$worker_tag" --target guest \
  -f "$repo/deploy/session-sandbox/firecracker/Dockerfile.guest" -t "$guest_tag" "$repo"
docker build --build-arg "WORKER_IMAGE=$worker_tag" --target rootfs-builder \
  -f "$repo/deploy/session-sandbox/firecracker/Dockerfile.guest" -t "$builder_tag" "$repo"
docker run --rm --network none --entrypoint /usr/bin/dpkg-query \
  "$guest_tag" -W > "$output/guest-package-manifest.txt"
container=$(docker create "$guest_tag")
docker export -o "$output/rootfs.tar" "$container"
docker rm "$container" >/dev/null
container=
# Extraction and mkfs run as container-root, preserving image ownership without
# privileged containers, loop mounts, host-root shells or a host Docker socket.
docker run --rm --network none --user 0:0 --entrypoint /bin/bash \
  -e "ROOTFS_SIZE_MIB=$rootfs_size" \
  -e "OUTPUT_UID=$(id -u)" -e "OUTPUT_GID=$(id -g)" \
  --mount "type=bind,src=$output,dst=/output" "$builder_tag" -ceu '
    mkdir /output/rootfs
    tar --extract --file /output/rootfs.tar --directory /output/rootfs
    truncate -s "${ROOTFS_SIZE_MIB}M" /output/rootfs.ext4
    /usr/sbin/mkfs.ext4 -q -F -L partitura-root -d /output/rootfs /output/rootfs.ext4
    chown "$OUTPUT_UID:$OUTPUT_GID" /output/rootfs.ext4
    rm -rf /output/rootfs /output/rootfs.tar
  '
(cd "$output" && sha256sum rootfs.ext4 > rootfs.ext4.sha256)
printf '%s\n' "$worker_image" > "$output/worker-image-id"
