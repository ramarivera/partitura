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
The container gets CPU, memory, pid, and writable-layer limits. `exec` can only
target the named session container and `/workspace`; it does not accept Docker
options or arbitrary host paths.

The gateway is not attached to worker networks. `relay` starts one fixed-target
TCP forwarder on the host side of the session bridge and accepts connections
only from that session's worker IP. Its Unix control connection owns the relay
lifetime. The gateway chooses the target service and port, then gives the worker
only the relay URL. `egress` starts an HTTPS CONNECT proxy on the same session
bridge address. It accepts exact hostnames from
`PARTITURA_SANDBOX_EGRESS_HOSTS`, port 443, and DNS results for which every
answer is globally routable. Workers have no direct DNS or Internet route.
Keep the allowlist to required package and model service hosts.

Before installing these units, the host operator must install and validate the
Sysbox runtime and confirm the Docker storage driver enforces `--storage-opt
size`. Pin `PARTITURA_SANDBOX_IMAGE` by digest, set
`PARTITURA_GATEWAY_CONTAINER` and `PARTITURA_GATEWAY_NETWORK` to the running
gateway container and its existing Docker network, set the workspace root,
resource limits, and exact egress host list in
`/etc/partitura-sandbox/broker.env`, and bind-mount the socket into the gateway
as `/run/partitura-sandbox/broker.sock`. Do not attach the gateway to session
networks or mount `/var/run/docker.sock` into the gateway. The socket unit
currently allows only root clients, matching the gateway container's root
identity.

The managed gateway install must also set `PARTITURA_SANDBOX_EGRESS_HOSTS` to
the exact comma-separated HTTPS hostnames workers need, such as the configured
model proxy and package registries. It defaults to an empty list, so worker
egress stays closed until an operator sets the allowlist. Review DNS results
before each connection; the broker rejects a hostname if any answer is not
globally routable. Keep this value in the deployment source of truth and apply
it to the broker service environment, not the gateway container.

This is preparation only. No Sysbox runtime, broker unit, socket mount, or live
sandbox has been installed or verified on arch-cachy. Sandbox mode must remain
disabled until the host routes are installed and acceptance tests prove the
restrictions.
