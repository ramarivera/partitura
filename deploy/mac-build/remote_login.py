#!/usr/bin/env python3
"""Opt-in admission of an already restricted build account to macOS Remote Login."""
import argparse
import os
from pathlib import Path
import re
import stat
import subprocess


def admit(account, apply=False, run=subprocess.run):
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,30}', account) or account == 'root':
        raise ValueError('invalid build account')
    groups = run(['/usr/bin/id', '-Gn', account], capture_output=True, text=True, check=True).stdout.split()
    if {'admin', 'wheel'} & set(groups):
        raise ValueError('build account must be unprivileged')
    policy = run(['/usr/sbin/sshd', '-T', '-C', f'user={account},host=localhost,addr=127.0.0.1'], capture_output=True, text=True, check=True).stdout
    fields = {key.lower(): value for key, value in (line.split(' ', 1) for line in policy.splitlines() if ' ' in line)}
    required = {
        'authorizedkeysfile': '/Library/Partitura/NativeBuild/authorized_keys',
        'forcecommand': '/usr/bin/python3 /Library/Partitura/NativeBuild/broker.py',
        'passwordauthentication': 'no', 'kbdinteractiveauthentication': 'no',
        'authenticationmethods': 'publickey', 'allowtcpforwarding': 'no',
        'allowagentforwarding': 'no', 'x11forwarding': 'no', 'permittty': 'no',
    }
    if any(fields.get(key) != value for key, value in required.items()):
        raise ValueError('install and verify the restricted native SSH policy first')
    # An absent service ACL means macOS already admits all local accounts.
    group = run(['/usr/bin/dscl', '.', '-read', '/Groups/com.apple.access_ssh'], capture_output=True, text=True)
    if group.returncode:
        if 'eDSRecordNotFound' not in group.stderr:
            raise ValueError('could not inspect Remote Login service ACL')
        return 'Remote Login has no selected-user ACL; no membership changed'
    member = run(['/usr/sbin/dseditgroup', '-o', 'checkmember', '-m', account, 'com.apple.access_ssh'], capture_output=True, text=True)
    if member.returncode == 0:
        return 'Restricted build account already admitted to Remote Login'
    if f'no {account} is NOT a member of com.apple.access_ssh' not in member.stdout:
        raise ValueError('could not verify Remote Login membership')
    if not apply:
        return 'Restricted build account needs explicit Remote Login membership approval'
    run(['/usr/sbin/dseditgroup', '-o', 'edit', '-a', account, '-t', 'user', 'com.apple.access_ssh'], capture_output=True, text=True, check=True)
    run(['/usr/sbin/dseditgroup', '-o', 'checkmember', '-m', account, 'com.apple.access_ssh'], capture_output=True, text=True, check=True)
    return 'Restricted build account admitted to Remote Login; membership verified'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.uname().sysname != 'Darwin' or os.geteuid() != 0:
        parser.error('run with sudo on the native Mac host')
    # The effective policy must refer to trusted installed files, not a checkout.
    for name in ('broker.py', 'authorized_keys'):
        path = Path('/Library/Partitura/NativeBuild') / name
        for item in (path, *path.parents):
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                parser.error('native SSH policy files must be sealed before admission')
    print(admit(args.account, args.apply))


if __name__ == '__main__':
    main()
