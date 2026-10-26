# Common build tools

Both container images and the generic macOS VM base include portable Mise.
`mise.toml` in this directory pins the common Node and Python versions. Image/base
preparation installs them once; jobs reuse those bytes. Repository `mise.toml`
files can select other versions, and repositories own any additional tools.
Neither the generic setup nor a job requires the operator's Toolbox configuration,
fnox, project credentials or a particular consumer repository.

`fetch-mise.sh` downloads Mise 2026.10.15 for Linux x64, Linux ARM64 or macOS ARM64.
It checks the asset against its SHA-256 digest from the upstream GitHub release
metadata before making it executable. It accepts an explicit output path and
doesn't change the host's installed Mise. A matching existing file is reused;
a different file or a symlink causes failure.

For a Mac base input, create a private scratch directory, then run:

```sh
bash deploy/build-tools/fetch-mise.sh macos-arm64 /absolute/scratch/mise-v2026.10.15-macos-arm64
```

Pass that file and its documented digest to `deploy/mac-build/prepare-base.sh`.
The Mac's existing Mise installation and configuration aren't inputs. The base
preparer copies the verified binary into the guest, installs the common runtimes
under the guest account, and verifies them without network access. The native
runner enters the repository through `mise exec` before invoking its build script.
See [Mac setup](../mac-build/README.md) for host preparation and approval requirements.

The gateway image keeps the shared runtime cache under
`/opt/partitura/mise/installs`, owned by root and unwritable by workers. The worker
helper creates links to those versions under each session's private Mise install
directory. A worker can install other versions without changing another session's
index or the cached binaries. Stable `/opt/partitura/bin` links also make common
commands available before a repository chooses its own versions.

The Sysbox worker image uses the same immutable cache, with its own writable
`/mise` index and cache inside each isolated container. Its image includes C/C++
build tools, CMake, pkg-config and the nested Docker CLI/daemon. The gateway image
includes the common compiler tools for workers that use UID isolation. macOS
provides its system build tools through the chosen clean image. Install Xcode or
Command Line Tools in that image when its intended jobs require them, with the
version and accepted Apple licenses recorded in the image's provenance.

Qualification must run the common versions with networking disabled and
auto-install disabled. A version print from the host or a successful image build
doesn't prove that a worker can use its cache. Check a non-root worker, its writable
install index, and the shared cache's write protection. macOS qualification is a
separate deployed-VM check; a Linux image test doesn't establish it.
