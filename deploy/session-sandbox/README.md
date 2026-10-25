# Session sandbox broker

The gateway connects only to the broker's Unix socket. The broker owns the
host runtime and workspace mounts. Firecracker is the default session backend;
Sysbox is an explicit alternative. Neither backend exposes the host Docker
socket to workers. Installing source files does not qualify a live deployment.

## Firecracker guest

The generic x86_64 Linux guest starts from the digest-pinned worker image built
by `Dockerfile.worker`. It includes the same immutable Mise Node/Python cache,
C/C++ build tools, CMake, Git, OMP, T3, Codex and Claude Code. The guest adds
SSHFS for its live session workspace and a Python standard-library control
agent. It contains no repository checkout, operator Mise/fnox configuration,
private keys or model credentials. Runtime credentials arrive only in the
session's authenticated control requests.

Build the kernel into scratch storage, from the repository root:

```sh
docker build -f deploy/session-sandbox/firecracker/Dockerfile.kernel \
  --build-arg JOBS=4 \
  --output type=local,dest=/absolute/scratch/kernel .
```

The recipe pins Linux 6.1.155 and verifies the kernel.org source archive SHA-256.
`kernel.config` builds virtio block, network and vsock, ext4, FUSE, overlayfs,
network namespaces, Docker bridge/NAT and cgroups into the kernel. Modules aren't
needed at boot. The output contains `vmlinux`, `.config` and its checksum. This
recipe targets x86_64; it doesn't qualify an ARM guest. The kernel source and
builder base are pinned. Debian package repositories still supply build tools,
so preserve the built artifact and hash rather than claiming a bit-identical
rebuild across repository updates.

Build a root filesystem from an existing immutable worker image ID:

```sh
bash deploy/session-sandbox/firecracker/build-rootfs.sh \
  sha256:<worker-image-id> /absolute/scratch/guest
```

The script exports the worker filesystem, adds guest init/control files and
SSHFS, then creates `rootfs.ext4` without privileged containers or host mounts.
The default sparse filesystem size is 12 GiB; `PARTITURA_ROOTFS_SIZE_MIB` changes
that build input. It emits `rootfs.ext4.sha256` and `worker-image-id`. Keep all
outputs outside the checkout. The input must come from the generic worker image,
not an operator's workstation image. Building uses the Docker API; workers never
receive that API socket.

The broker copies the base disk for each session. `/dev/vda` is that writable
ext4 root; `/dev/vdb` is a separate read-only configuration disk containing
root-owned mode-0400 `config.json` with a fresh 64-character hex `token` and the
numeric `workerUid`. Start with `root=/dev/vda rw init=/sbin/partitura-init
console=ttyS0 reboot=k panic=1 pci=off`. Init mounts proc, sysfs, devtmpfs,
cgroup v2 and bounded `/run` and `/tmp` tmpfs filesystems. It enables loopback,
starts the nested Docker daemon and listens on guest vsock port 52. The VM has
no network interface. Docker's data lives in local ext4 `/var/lib/docker`,
not on the workspace FUSE mount.

The live workspace uses SSHFS slave mode over vsock to a host SFTP process.
The host process runs as the session uid in a restricted filesystem jail that
contains only its `/workspace` and the fixed SFTP executable/libraries. The
worker's host workspace stays live for gateway Git and T3 operations. No SSH
server, SSH keys or host-root filesystem is exposed. The authenticated
`mount-workspace` request connects guest vsock CID 2 to host port 1080, then
runs SSHFS with `allow_other`, `default_permissions`, `uid`/`gid` mapping,
`nodev` and `nosuid`. Workspace programs can execute. Session readiness requires
the mount, not just a successful control-agent ping.

The guest binds `/workspace/node_modules` to a private directory on its existing
session disk. Package imports therefore use local ext4 rather than one SFTP
operation per dependency file. These files survive recovery with that VM and
leave with its disk at teardown. They aren't copied to the host source workspace
or shared with another session. Commands and Docker build contexts running in
the guest see the local dependencies; host-side tools see only the source
workspace. Nested package directories aren't redirected. Existing host-side
`node_modules` contents remain hidden inside the guest, so install dependencies
there before running repository tools. Symlinks, foreign owners and mismatched
existing mounts fail session readiness.

The guest mount uses `no_contain_symlinks` because Mise records absolute config
links and package managers create parent-relative dependency links. Debian's
SSHFS containment default rejects both forms. This option permits links to
resolve elsewhere in the disposable guest, subject to its filesystem permissions.
It does not expose host paths beyond the session's existing SFTP jail. Keep the
host jail, session UID, `default_permissions`, `nodev` and `nosuid` controls.
Changing this containment setting requires operator approval before deploying
the guest image. The live qualification checks absolute and parent-relative
links together with the existing cross-session denial tests.

An immutable host Python helper enters the numeric session identity before
executing the VMM or SFTP server. It permanently sets all user/group IDs,
clears every capability set and enables `no_new_privs`. This avoids depending
on systemd accepting a UID without a host account. OpenSSH's `getpwuid` lookup
uses a synthetic passwd/group pair inside that session's private SFTP jail.
Those files never change host accounts and leave with the same session lifecycle.

Host-to-guest connections use Firecracker's Unix vsock socket handshake
`CONNECT 52` followed by newline. The agent then accepts one newline-terminated
JSON request containing the token. `exec` validates the session uid, canonical
workspace cwd and environment allowlist, then drops uid/gid, clears extra groups
and sets `no_new_privs`. Input uses `I` plus a four-byte big-endian length and
payload, or `C` plus four zero bytes to close stdin. Output uses `O`/`E` plus
length/payload; `X` plus a four-byte exit code ends the command. Frames are
bounded to 4 MiB and request JSON to 1 MiB. Closing the owner connection kills
the command's process group, including after stdin closes.

`listen` creates a control-owned guest loopback listener and forwards it to a
fixed host vsock port. Port zero requests an allocated loopback port. Closing
the control connection stops the listener. `tunnel` connects to a guest loopback
service for gateway-to-worker traffic. The egress listener uses guest loopback
3128 and host vsock 1081; the host applies the configured public-web or hostname-allowlist policy.
Guest Docker inherits that proxy. There is no direct Internet or host network
route from the VM.

Configure `PARTITURA_FIRECRACKER_BINARY`, `PARTITURA_FIRECRACKER_KERNEL` and
`PARTITURA_FIRECRACKER_ROOTFS` to installed, validated artifacts. The broker's
default artifact locations are `/usr/local/bin/firecracker`,
`/opt/partitura-sandbox/vmlinux` and `/opt/partitura-sandbox/rootfs.ext4`.
`PARTITURA_FIRECRACKER_SFTP_ROOT` identifies the prepared fixed SFTP runtime
jail, and `PARTITURA_FIRECRACKER_VM_ROOT` holds per-session disk/state directories.
The host needs usable KVM and a qualified Firecracker binary. Source-only tests
don't prove guest boot, nested Docker or the deployed SFTP jail works.

Run the guest protocol tests as root inside a disposable worker container:

```sh
docker run --rm --network none --entrypoint /opt/partitura/bin/python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --mount type=bind,src=/absolute/checkout,dst=/source,readonly \
  sha256:<worker-image-id> /source/test/firecracker-guest.test.py
```

Those tests exercise real process uid/group changes, environment stripping,
framed stdin/stdout/stderr and exit status, process cleanup after disconnect,
request validation and relay-listener lifetime. Boot qualification must also
check the actual VM's live host/guest workspace writes, common tools without
networking, nested Docker build/run and denied host/private-network access.

## Sysbox alternative

The broker's operations are `provision`, `recover`, `exec`, `relay`, `egress`,
and `destroy`. Provisioning accepts a canonical workspace under the configured
workspace root, creates a per-session internal Docker network and Sysbox
container, mounts only that workspace, and creates a per-session Mise volume.
The volume persists through worker restarts and is removed with the session.
The container gets CPU, memory, and pid limits. Its `/run` and `/tmp` tmpfs
mounts have fixed sizes. The writable layer, workspace bind mount, and Mise
volume do not have a per-session disk quota on the current Docker driver, so
operators must budget host storage, monitor host free space and Docker volume
use, and keep workspace and volume retention running. `exec` can only target
the named session container and `/workspace`; it does not accept Docker options
or arbitrary host paths.

Each Sysbox Docker mutation runs in a broker-owned transient systemd unit.
The same session record stores its unit identity before submission. A request
timeout leaves the Docker client running; recovery and teardown retain ownership
until its normal successful exit is recorded. Missing or failed operation
evidence fails closed and needs operator investigation. Running containers get
a bounded graceful stop before removal so nested Docker can exit. There is no
second session database or independent container inventory to reconcile.

The gateway is not attached to worker networks. `relay` starts one fixed-target
TCP forwarder on the host side of the session bridge. It accepts connections
from the worker IP for gateway-bound relays and from the gateway network owner
for worker-bound relays. Its Unix control connection owns the relay lifetime.
The gateway chooses the target service and port, then gives the worker only the
relay URL. `egress` starts an HTTP/HTTPS proxy on the same session bridge address. By
default it permits public destinations on ports 80 and 443 after checking every
DNS answer. Restricted deployments can select `allowlist` mode and enumerate
`PARTITURA_SANDBOX_EGRESS_HOSTS`. Workers have no direct DNS or Internet route.
Private destinations require exact configured HTTPS provider pins.

Host INPUT firewalls can block these listeners even when Docker forwarding works.
The optional `PARTITURA_SANDBOX_MANAGE_FIREWALL=true` mode creates one IPv4 TCP
INPUT exception for each listener's exact expected source, bridge address and
port. It doesn't enable direct Internet routing or grant access to other host
ports. Each rule carries the owning systemd invocation ID. Closing the control
connection removes its rule, and `ExecStopPost` repeats cleanup after process
failure or termination. Other requests' rules and operator rules stay intact.
This mode requires host-operator approval, the host's existing iptables backend,
and the service's AF_NETLINK allowance. It defaults to false. A firewall reload
can remove an active exception; restart affected workers after such a reload.

Before installing these units, the host operator must install and validate the
Sysbox runtime. Set `PARTITURA_WORKSPACE_ROOT=/app/workspaces` to the gateway
container's logical workspace root and set `PARTITURA_WORKSPACE_HOST_ROOT` to
the host path mounted there. For a named Compose volume, derive that host path with
`docker volume inspect <compose-project>_gateway-workspaces --format
'{{.Mountpoint}}'`; never pass `/app/workspaces` as a host path. The broker maps
the request's relative session path into this root and rejects traversal,
symlinks, and paths outside it. Pin `PARTITURA_SANDBOX_IMAGE` by digest, set
`PARTITURA_GATEWAY_CONTAINER` and `PARTITURA_GATEWAY_NETWORK` to the running
gateway container and its existing Docker network. If the gateway shares a
network namespace with Tailscale, set `PARTITURA_GATEWAY_NETWORK_CONTAINER` to
that network-owner container; it defaults to the gateway container when
Tailscale is disabled. Set the logical workspace root and host mount root,
resource limits, and exact egress host list in
`/etc/partitura-sandbox/broker.env`, and bind-mount the socket into the gateway
as `/run/partitura-sandbox/broker.sock`. Do not attach the gateway to session
networks or mount `/var/run/docker.sock` into the gateway. The socket unit
currently allows only root clients, matching the gateway container's root
identity.

`PARTITURA_SANDBOX_EGRESS_MODE=public-web` is the default. Workers can reach any
public HTTP service on TCP 80 and HTTPS service on TCP 443, including package
registries, mirrors, redirects, and artifact verification services. There is no
hostname list to maintain for public web access. For a restricted deployment,
set `PARTITURA_SANDBOX_EGRESS_MODE=allowlist` and supply exact comma-separated
hostnames in `PARTITURA_SANDBOX_EGRESS_HOSTS`. An empty allowlist denies egress.
Both modes validate every DNS answer before connecting and reject a hostname
if any answer isn't globally routable. An operator can explicitly approve a private HTTPS
service by setting `PARTITURA_SANDBOX_PRIVATE_EGRESS_ADDRESSES_JSON` to an object
mapping an already-allowed hostname to exact IP addresses. It defaults to `{}`.
Pinned hosts must resolve entirely within their approved address set, and the
proxy connects to the validated address without resolving it again. Private
pins remain HTTPS-only in either mode. CIDRs,
loopback, link-local, metadata, multicast, unspecified, and reserved addresses
are refused. CONNECT supports only ports 80 and 443; absolute-form HTTP requests
support only port 80 and discard proxy credentials before forwarding. This is a protected access
grant, so review and approve it before deployment. Keep both settings in the
deployment source of truth and apply them to the broker service environment,
not the gateway container. A changed service address requires a reviewed pin
update; it doesn't broaden access automatically.

Build the worker image from `Dockerfile.worker`. It pins Bun, Docker, Mise,
Node, Python, OMP, Claude Code, T3, and Codex versions. Node 24.22.1 and
Python 3.13.17 come from `deploy/build-tools/mise.toml`; the image keeps their
root-owned installs under `/opt/partitura/mise/installs`. Stable `node`, `npm`,
`npx`, `python`, and `python3` links in `/opt/partitura/bin` make those
versions available on `PATH` before a repository supplies its own Mise config.
Use `mise exec` to run repository-pinned versions. At startup,
`worker-init.sh` creates session-owned links in `/mise/installs`, so Mise can
use those immutable runtimes while repository-specific versions install into
the writable `/mise` volume. The volume also holds `/mise/cache`; Mise config
stays under `/workspace/.omp-home/mise/config`. No writable cache is shared
between sessions, and the `/mise` volume is removed with its session.

`worker-init.sh` also starts one nested Docker daemon per Sysbox container and
stores its data under the session workspace. The socket stays at
`/run/docker.sock` inside that container. The broker never mounts the host
Docker socket. The outer session proxy variables are present before `dockerd`
starts, so inner Docker image pulls use the same configured egress policy.

For launched T3 sessions, the gateway MCP endpoint also receives a
session-owned broker relay into the gateway's configured Docker network. T3's
provider settings use that relay address, so native Linear tools remain
available inside the isolated container without attaching it to the gateway
network or exposing gateway credentials.

At the time this preparation was written, `arch-cachy` Docker used the containerd snapshotter on btrfs, and
this broker does not enforce per-session disk quotas. Sandbox mode remains
unqualified there until Sysbox and the selected init and nested toolchain meet
their documented capability requirements. Keep the shared toolbox daemon
untouched. Any future disk-quota requirement needs a separately qualified
storage design; don't treat the container CPU, memory, pid, or tmpfs limits as
a quota for the workspace bind mount, Mise volume, or writable layer.

Keep deployment qualification separate from this source documentation. A host
operator must verify the installed runtime, broker, workspace mount, nested
Docker and egress restrictions before enabling either backend for sessions.
