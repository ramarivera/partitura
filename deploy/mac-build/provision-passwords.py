#!/usr/bin/env python3
"""Feed two explicitly supplied passwords to the canonical macOS provisioner."""
import argparse
import errno
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time

ADMIN_PROMPT = b'PARTITURA_ADMIN_PASSWORD: '
BUILD_PROMPTS = (b'Dedicated account password: ', b'Repeat dedicated account password: ')
MAX_INPUT = 16384
FAILURE_REASONS = {
    'timeout': 'provisioning timed out',
    'password-rejected': 'password was rejected; automatic retry refused',
    'echo-enabled': 'password prompt has terminal echo enabled',
}


class ProvisionFailure(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(FAILURE_REASONS[code])


def failure_message(error):
    reason = FAILURE_REASONS.get(error.code) if isinstance(error, ProvisionFailure) else None
    return 'Password-driven provisioning stopped' + (f': {reason}.' if reason else '.') + ' No password is printed or retried.'


def passwords(stream):
    raw = bytearray(stream.read(MAX_INPUT + 1))
    result = {}
    try:
        if len(raw) > MAX_INPUT:
            raise ValueError('password input exceeds bounds')
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate password field')
                value[key] = item
            return value
        value = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(value, dict) or set(value) != {'administratorPassword', 'buildAccountPassword'}:
            raise ValueError('expected exactly administratorPassword and buildAccountPassword')
        for name, password in value.items():
            if not isinstance(password, str):
                raise ValueError('password must be text')
            encoded = bytearray(password.encode())
            if not 1 <= len(encoded) <= 1024 or any(char < 32 or char == 127 for char in encoded):
                raise ValueError('password input has invalid length or characters')
            result[name] = encoded
        return result
    except (ValueError, UnicodeError):
        for password in result.values():
            password[:] = b'\0' * len(password)
        raise ValueError('invalid password input') from None
    finally:
        raw[:] = b'\0' * len(raw)


def run_provision(command, secrets, output, timeout=7200):
    """Own one terminal session, refuse echo, and never retry a password."""
    master, slave = pty.openpty()
    terminal = os.ttyname(slave)
    environment = dict(os.environ, SUDO_PROMPT=ADMIN_PROMPT.decode(), LC_ALL='C')
    # Opening the terminal after setsid acquires it without unsafe preexec_fn.
    launcher = 'import os,sys; fd=os.open(sys.argv[1],os.O_RDWR); os.close(fd); os.execv(sys.argv[2],sys.argv[2:])'
    child = subprocess.Popen([sys.executable, '-I', '-c', launcher, terminal, *command],
                             stdin=slave, stdout=slave, stderr=slave,
                             env=environment, start_new_session=True)
    os.close(slave)
    deadline = time.monotonic() + timeout
    pending = bytearray()
    answered = set()
    prompts = {ADMIN_PROMPT: secrets['administratorPassword'],
               **{prompt: secrets['buildAccountPassword'] for prompt in BUILD_PROMPTS}}
    redactions = re.compile(b'|'.join(re.escape(bytes(value)) for value in sorted(secrets.values(), key=len, reverse=True)))
    try:
        while True:
            if time.monotonic() >= deadline:
                raise ProvisionFailure('timeout')
            if not select.select([master], [], [], 0.2)[0]:
                if child.poll() is not None:
                    break
                continue
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            pending.extend(data)
            for prompt, password in prompts.items():
                if prompt not in pending:
                    continue
                if prompt in answered:
                    raise ProvisionFailure('password-rejected')
                if termios.tcgetattr(master)[3] & (termios.ECHO | termios.ECHONL):
                    raise ProvisionFailure('echo-enabled')
                os.write(master, password + b'\n')
                answered.add(prompt)
                pending[:] = pending.replace(prompt, b'[private password supplied]')
            # Keep a bounded suffix so split prompts and any echoed supplied
            # password cannot escape redaction at a read boundary.
            keep = max(2048, *(len(value) + 1 for value in secrets.values()))
            if len(pending) > keep:
                cut = len(pending) - keep
                for match in redactions.finditer(pending):
                    if match.start() >= cut:
                        break
                    if match.end() > cut:
                        cut = match.end()
                        break
                output.write(redactions.sub(b'[redacted]', pending[:cut]))
                output.flush()
                del pending[:cut]
        output.write(redactions.sub(b'[redacted]', pending))
        output.flush()
        return child.wait(timeout=10)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
        os.close(master)
        for value in secrets.values():
            value[:] = b'\0' * len(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    arguments = args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments
    if os.uname().sysname != 'Darwin' or os.geteuid() == 0:
        parser.error('run as the macOS administrator account')
    if '--apply' not in arguments:
        parser.error('use the ordinary provisioner for read-only preflight')
    provisioner = Path(__file__).resolve().with_name('provision-host.sh')
    secrets = passwords(sys.stdin.buffer)
    try:
        return run_provision(['/bin/bash', str(provisioner), *arguments], secrets, sys.stdout.buffer)
    finally:
        for password in secrets.values():
            password[:] = b'\0' * len(password)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(failure_message(error), file=sys.stderr)
        sys.exit(1)
