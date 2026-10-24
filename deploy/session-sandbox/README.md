# Session sandbox broker source

This directory contains the host-side broker source and systemd unit templates
for a future Sysbox deployment. It does not install Sysbox or change host access
controls. The gateway connects only to the broker's Unix socket; the broker is
the only process that uses the host Docker API.

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

The gateway is not attached to worker networks. `relay` starts one fixed-target
TCP forwarder on the host side of the session bridge. It accepts connections
from the worker IP for gateway-bound relays and from the gateway network owner
for worker-bound relays. Its Unix control connection owns the relay lifetime.
The gateway chooses the target service and port, then gives the worker only the
relay URL. `egress` starts an HTTPS CONNECT proxy on the same session
bridge address. It accepts exact hostnames from
`PARTITURA_SANDBOX_EGRESS_HOSTS`, port 443, and DNS results for which every
answer is globally routable. Workers have no direct DNS or Internet route.
Keep the allowlist to required package and model service hosts.

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

The managed gateway install must also set `PARTITURA_SANDBOX_EGRESS_HOSTS` to
the exact comma-separated HTTPS hostnames workers need, including
`cliproxyapi.ai.roxasroot.net` for the configured model proxy and any package
registries used by worker tools. It defaults to an empty list, so worker
egress stays closed until an operator sets the allowlist. Review DNS results
before each connection; the broker rejects a hostname if any answer is not
globally routable. Keep this value in the deployment source of truth and apply
it to the broker service environment, not the gateway container.

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
starts, so inner Docker image pulls use the same exact-host egress policy.

For launched T3 sessions, the gateway MCP endpoint also receives a
session-owned broker relay into the gateway's configured Docker network. T3's
provider settings use that relay address, so native Linear tools remain
available inside the isolated container without attaching it to the gateway
network or exposing gateway credentials.

The current `arch-cachy` Docker uses the containerd snapshotter on btrfs, and
this broker does not enforce per-session disk quotas. Sandbox mode remains
unqualified there until Sysbox and the selected init and nested toolchain meet
their documented capability requirements. Keep the shared toolbox daemon
untouched. Any future disk-quota requirement needs a separately qualified
storage design; don't treat the container CPU, memory, pid, or tmpfs limits as
a quota for the workspace bind mount, Mise volume, or writable layer.

This is preparation only. No Sysbox runtime, broker unit, socket mount, worker
image, or live sandbox has been installed or verified on arch-cachy. Sandbox
mode must remain disabled until the host routes are installed and acceptance
tests prove the restrictions.
