# Live sandbox acceptance

`test/session-sandbox-live.test.py` talks to the installed Unix broker socket.
It doesn't import broker implementation code. Its four local fixture tests run
without host privileges or network access. The two live tests require explicit
opt-in and root on the sandbox host. They exercise Firecracker with the runtime
field omitted, then explicit Sysbox, using the same lifecycle protocol.

Run the local fixtures from the checkout. Set `TMPDIR` to an existing scratch
directory, outside the repository.

```nu
with-env {TMPDIR: $scratch_dir, PYTHONDONTWRITEBYTECODE: "1"} {
  python3 test/session-sandbox-live.test.py -v
}
```

The live run creates two disposable sessions at a time. It pulls one small,
digest-pinned Docker image, builds an image inside each session's Docker daemon,
starts real T3 servers and issues local T3 bearer credentials. It requests T3
websocket tickets but doesn't create a thread, call a model, or spend model
tokens. It doesn't install dependencies, change host configuration, or restart
the gateway. Allow roughly ten minutes with a warm image cache. Don't run other
sandbox acceptance/deployment work concurrently because firewall cleanup checks
compare the host's tagged rules before and after this run.

Before opting in, install the broker, worker image, kernel, guest rootfs, minimal
SFTP root and systemd units through the managed deployment. The rootfs must
contain SSHFS and the kernel must support KVM guest operation, vsock, FUSE,
cgroups and nested Docker. The host must provide `/dev/kvm`. Keep the broker's
root-only socket policy in force. Source tests passing don't establish any of
these live prerequisites.

Choose two unused UIDs from the gateway's configured worker pool. Neither may
name a host account, own a host process or have an existing lifecycle record.
The runner checks those conditions before creating resources. Run during an
idle gateway window so production allocation can't claim those UIDs. Set
`$workspace_host_root` to the actual broker host root from its managed config,
`$gateway_container` to the gateway container with Bun and its normal network
namespace, and `$nested_image` to an approved Alpine-compatible image reference
with a `@sha256:` digest. The image must have `/bin/sh`, `cat` and `printf`.
Its registry, auth and blob CDN hostnames must be in the approved egress list.

From the checkout on the sandbox host, this command works in Nushell:

```nu
sudo env PARTITURA_SANDBOX_LIVE=1 PYTHONDONTWRITEBYTECODE=1 $"TMPDIR=($scratch_dir)" PARTITURA_SANDBOX_LIVE_UID=1064 PARTITURA_SANDBOX_LIVE_PEER_UID=1063 $"PARTITURA_SANDBOX_LIVE_WORKSPACE_HOST_ROOT=($workspace_host_root)" $"PARTITURA_SANDBOX_LIVE_GATEWAY_CONTAINER=($gateway_container)" $"PARTITURA_SANDBOX_LIVE_DOCKER_IMAGE=($nested_image)" python3 test/session-sandbox-live.test.py -v
```

The defaults are logical workspace root `/app/workspaces`, gateway port `3000`,
socket `/run/partitura-sandbox/broker.sock`, state root
`/var/lib/partitura-sandbox`, VM root `/var/lib/partitura-vms`, and Docker
`/usr/bin/docker`. Override the corresponding
`PARTITURA_SANDBOX_LIVE_WORKSPACE_ROOT`, `GATEWAY_PORT`, `SOCKET`, `STATE_ROOT`,
`VM_ROOT` or `DOCKER` variable when managed configuration differs.
To qualify one runtime independently, append
`SandboxLiveTests.test_default_firecracker_lifecycle` or
`SandboxLiveTests.test_explicit_sysbox_lifecycle` to the command.

Each runtime must pass all of these checks:

- Provisioning and returned runtime match the selection. Two sessions have
  separate UIDs and cannot read each other's private workspace data.
- Broker exec sends actual stdin, stdout, stderr and exit status. Wrong worker
  identities fail for exec, relay, egress and recovery. The Firecracker guest
  rejects another session's control token, uses a different kernel from the
  host and has exactly loopback and the internal Docker bridge. The bridge must
  be a Linux bridge, and neither IPv4 nor IPv6 may have an external default route.
- Node 24, Python 3.13 and Mise execute as the session UID. Nested Docker runs
  an image, builds a Dockerfile containing a `RUN` step and runs the result.
  Readiness retries are bounded to 120 seconds, with each Docker info request
  limited to two seconds. A dead daemon recorded in its pidfile fails the check.
- A worker remains active while a host write becomes visible inside the guest,
  and its reply becomes visible on the host with the session's ownership.
- Firecracker's root `node_modules` and `$HOME/.local/share/pnpm/store` use the
  session's local disk, belong to the worker and survive recovery. Their files
  stay absent from the host source and peer VM. A real nested Docker build copies
  the module marker from its build context.
- The allowed npm HTTPS endpoint works, a disallowed hostname returns proxy
  403 and direct external TCP access fails. The proxy opens before tooling
  starts, matching gateway startup, so Mise can use the approved network route.
- A gateway-bound relay reaches the real gateway health endpoint and gets 401
  at an unauthenticated admin endpoint. It also reaches a disposable listener
  bound to the exact `gatewayAddress` returned by provision, matching Git/MCP
  listener binding. This listener serves only a random test marker and stops
  explicitly, with a 90 second safety timeout. A worker-bound relay reaches a real T3
  server, validates protocol 2, denies a missing bearer, accepts its own bearer
  and denies that bearer at a second session's T3 server.
- Disconnecting exec stops parent and child heartbeats. Recovery retires an
  active orphan, retains Mise data and the live workspace, and starts usable
  nested Docker again.
- Destroy is idempotent. Independent host reads find no owned VM directory,
  lifecycle/machine record, transient VMM/workspace/SFTP service, Docker
  container including stopped containers, network or volume. Closing all
  control connections removes the run's added tagged firewall rules.

The runner registers teardown before provisioning and cleans up after test
failures. It prints every owned session ID. If runtime teardown fails, it fails
the test and leaves that session's workspace for diagnosis rather than deleting
files while a worker may still write. Check those exact IDs through the broker
and systemd before retrying cleanup. Cross-request `.lock` files intentionally
remain because unlinking a file used by `flock` could split lifecycle locking.

A passing local fixture run reports two live skips. That isn't live acceptance.
Record the installed broker/kernel/rootfs hashes and full host-side test output
in scratch storage with the deployment evidence before claiming the default
runtime is usable.
