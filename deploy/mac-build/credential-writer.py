#!/usr/bin/env python3
"""Human-only, no-echo initialization of the dedicated login credential."""
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import tempfile
import termios

CONFIG = Path('/Library/Partitura/NativeBuild/config.json')


def dedicated_home(bootstrap=False):
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir)
    if os.getuid() == 0 or home != Path('/Users') / account.pw_name or os.environ.get('HOME') != str(home):
        raise ValueError('run as the configured dedicated account with sudo -H and python3 -I')
    info = home.lstat()
    if home.resolve() != home or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('dedicated home must be owned mode 0700')
    # Fresh one-shot setup initializes the keychain before the fenced installer
    # transaction can apply/read back its settings. This only writes the caller's
    # own private credential. An installed config always retains its binding.
    if bootstrap and not os.path.lexists(CONFIG):
        return home
    for path in (CONFIG, *CONFIG.parents):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe installed configuration')
    config = json.loads(CONFIG.read_bytes())
    if config['keychainCredentialPath'] != str(home / '.partitura-native-login.password') or config['keychainPath'] != str(home / 'Library/Keychains/login.keychain-db'):
        raise ValueError('caller is not the configured dedicated account')
    return home


def read_hidden(tty, prompt):
    os.write(tty, prompt)
    password = bytearray()
    while True:
        value = os.read(tty, 1)
        if not value:
            raise ValueError('password input ended')
        if value in (b'\n', b'\r'):
            break
        password.extend(value)
        if len(password) > 1024 or value == b'\0':
            raise ValueError('password exceeds input bounds')
    os.write(tty, b'\n')
    if not password:
        raise ValueError('empty password refused')
    return password


def publish(home, password):
    """Publish atomically without replacing any existing credential or link."""
    final = home / '.partitura-native-login.password'
    descriptor, name = tempfile.mkstemp(prefix='.partitura-login-', dir=home)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as destination:
            destination.write(password)
            destination.flush()
            os.fsync(destination.fileno())
        # link is exclusive even if final is a dangling symlink. Unlike rename,
        # it cannot silently replace an existing credential on macOS.
        os.link(temporary, final, follow_symlinks=False)
        temporary.unlink()
        directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def main(bootstrap=False):
    os.umask(0o077)
    home = dedicated_home(bootstrap=True) if bootstrap else dedicated_home()
    if os.path.lexists(home / '.partitura-native-login.password'):
        raise ValueError('new credential path already exists; refusing overwrite')
    first = second = bytearray()
    tty = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    original = termios.tcgetattr(tty)
    hidden = termios.tcgetattr(tty)
    hidden[3] &= ~(termios.ECHO | termios.ECHONL)
    try:
        termios.tcsetattr(tty, termios.TCSAFLUSH, hidden)
        first = read_hidden(tty, b'Dedicated account password: ')
        second = read_hidden(tty, b'Repeat dedicated account password: ')
        if first != second:
            raise ValueError('password entries differ')
        publish(home, first)
    finally:
        first[:] = b'\0' * len(first)
        second[:] = b'\0' * len(second)
        termios.tcsetattr(tty, termios.TCSAFLUSH, original)
        os.close(tty)
    print('Dedicated credential created, mode 0600. No existing credential changed.')
    return 0


if __name__ == '__main__':
    try:
        if sys.argv[1:] not in ([], ['--bootstrap']):
            raise ValueError('unsupported credential initialization option')
        sys.exit(main(bootstrap=sys.argv[1:] == ['--bootstrap']))
    except (OSError, ValueError, KeyError, termios.error):
        print('Credential initialization stopped. No password is printed; do not repeat automatically.', file=sys.stderr)
        sys.exit(1)
