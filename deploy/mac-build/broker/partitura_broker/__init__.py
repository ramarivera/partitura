#!/usr/bin/env python3
"""Installed SSH forced command. Caller code executes only inside a disposable VM."""
from __future__ import annotations

import fcntl
import contextlib
import ctypes as C
import hashlib
import io
import json
import math
import os
import pwd
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import tarfile
import threading
import tempfile
import time
import uuid

CONFIG = Path('/Library/Partitura/NativeBuild/config.json')
MAX_BUNDLE = 1024 * 1024 * 1024
MAX_ARTIFACT = 2 * MAX_BUNDLE
MAX_BOOT_LOG = 65536
MAX_WORKFLOW_LOG = 1024 * 1024
ARTIFACT_RETENTION_SECONDS = 7 * 24 * 60 * 60
ARTIFACT_STORAGE_LIMIT = 8 * MAX_BUNDLE
JOB = r'[a-f0-9]{32}'
COMMIT = r'[a-f0-9]{40}'
RUN = re.compile(rf'run ({JOB}) ({COMMIT}) ([1-9][0-9]{{0,7}}) ([a-z][a-z0-9-]{{0,63}}) ([1-9][0-9]{{0,9}})(?: ([1-9][0-9]{{0,4}}))?')
READ = re.compile(rf'(status|artifact|cancel) ({JOB})')
RUN_V2 = re.compile(rf'run-v2 ({JOB}) ({COMMIT}) ([1-9][0-9]{{0,7}}) ([a-z][a-z0-9-]{{0,63}}) ([1-9][0-9]{{0,9}}) (0|[1-9][0-9]{{0,4}}) ({JOB}) ({JOB}) ([1-9][0-9]{{0,9}})')
PROTOCOL_VERSION = 2
BROKER_FILE = Path(getattr(__loader__, 'archive', '/dev/null'))
BROKER_REVISION = hashlib.sha256(BROKER_FILE.read_bytes()).hexdigest()
DISK_FLOOR = 50 * 1024**3
HISTORY_RETENTION_SECONDS = 30 * 24 * 60 * 60
HISTORY_PASS_SECONDS = 10
MAX_STATE = 4096
TERMINAL = ('succeeded', 'failed', 'cancelled')
FENCES = ('active-vm', 'cleanup-required', 'unlock-attempt', 'keychain-relock-pending')
MAINTENANCE_REASONS = ('maintenance-stale', 'storage-permission-denied', 'storage-access-denied', 'inventory-unavailable', 'inventory-invalid', 'inventory-incomplete', 'runner-owner-missing', 'runner-owner-unavailable', 'runner-owner-alive', 'runner-owner-ambiguous', 'keychain-relock-pending', 'cleanup-required', 'diagnostics-unavailable')


from .identity import parse_command, sealed, load_config, validate_keychain_paths, KeychainError, validate_keychain_policy, policy_evidence, KeychainSettings, LoginKeychain
from .vm import verify_vm_capacity, receive, stop, capture_boot_log, diagnostic_receipt, owned, prepare_clone, bounded_output, delivers_artifact, package_workflow_logs
from .state import durable_write, sync_directory, durable_remove, record, housekeeping_counts, record_housekeeping, prune_artifacts, environment_for, destroy_vm, ignore_shutdown_signals, private_directory, read_state, unique_object, json_state, fence_job, admission_epoch, initialize_epoch, emit, runner_state, process_start, owner_block_reason, obligations, run_lock, disk_space, require_disk, DiskUnavailable, registry_status, health
from .recovery import tombstone, verify_owned_clone, macos_build, daemon_relock_qualified, keychain_relock_entry, relock_keychain, remove_partial_input, inspect_job_directory, reconcile_locked, reconcile, InventoryPending, inventory_obligations, boot_id, maintenance_state, record_maintenance, history_gc_due, prune_history, local_maintenance, refuse
from .execution import run_v2, cancel_job, RunnerMarker, run_job, main, cli

from .diagnostics import maintenance_error, prepare_maintenance_stderr

from .maintenance import health_maintenance_reasons, StorageProbeError, tart_path, maintenance_heartbeat, maintenance_stale, maintenance_stderr, storage_result, maintenance_identity, storage_access_denied, record_storage_denial, check_maintenance_storage, loopback_maintenance, MAINTENANCE_VERBS, STORAGE_ACCESS_HINT
