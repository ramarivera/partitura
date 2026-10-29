"""Exercise the actual private terminal transport without changing a host."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/mac-build/provision-passwords.py'
spec = importlib.util.spec_from_file_location('provision_passwords', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PasswordProvisionTests(unittest.TestCase):
    def secret_values(self):
        return dict(administratorPassword=bytearray(b'private-admin-fixture'),
                    buildAccountPassword=bytearray(b'private-build-fixture'))

    def test_input_is_closed_and_bounded(self):
        value = module.passwords(io.BytesIO(json.dumps(dict(administratorPassword='one', buildAccountPassword='two')).encode()))
        self.assertEqual(value['administratorPassword'], b'one')
        for supplied in ({}, {'administratorPassword': 'one'},
                         dict(administratorPassword='one', buildAccountPassword='two', extra='no'),
                         dict(administratorPassword='', buildAccountPassword='two'),
                         dict(administratorPassword='x\nno', buildAccountPassword='two'),
                         dict(administratorPassword='x\x03no', buildAccountPassword='two'),
                         dict(administratorPassword='x\x7fno', buildAccountPassword='two'),
                         dict(administratorPassword='one', buildAccountPassword='x' * 1025)):
            with self.subTest(supplied=list(supplied)), self.assertRaises(ValueError):
                module.passwords(io.BytesIO(json.dumps(supplied).encode()))
        with self.assertRaises(ValueError):
            module.passwords(io.BytesIO(b' ' * (module.MAX_INPUT + 1)))
        with self.assertRaises(ValueError):
            module.passwords(io.BytesIO(b'{"administratorPassword":"one","administratorPassword":"two","buildAccountPassword":"three"}'))

    def test_real_terminal_feeds_each_password_without_args_environment_or_output_leak(self):
        program = '''
import hashlib,os,subprocess,sys,termios
fd=os.open('/dev/tty',os.O_RDWR)
mode=termios.tcgetattr(fd);mode[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(fd,termios.TCSANOW,mode)
marker=bytes((112,114,105,118,97,116,101,45))
assert not any(marker.decode() in value for value in os.environ.values())
assert marker not in subprocess.check_output(['/bin/ps','-o','args=','-p',str(os.getpid())])
for prompt,expected in [(os.environ['SUDO_PROMPT'].encode(),'475b7fcdf650cd96d0e81a08cfa035f0732722404ae0d40c40c7a230d208df5b'),(b'Dedicated account password: ','8accf1d102dbde7142be20213676fcc182327ad84519d3a5f13d365cd8360f32'),(b'Repeat dedicated account password: ','8accf1d102dbde7142be20213676fcc182327ad84519d3a5f13d365cd8360f32')]:
 os.write(fd,prompt[:7]);os.write(fd,prompt[7:])
 assert hashlib.sha256(os.read(fd,2048).rstrip(b'\\n')).hexdigest()==expected
os.write(fd,b'accepted\\n')
'''
        secrets = self.secret_values()
        output = io.BytesIO()
        self.assertEqual(module.run_provision([sys.executable, '-I', '-c', program], secrets, output, timeout=10), 0)
        self.assertIn(b'accepted', output.getvalue())
        self.assertNotIn(b'private-admin-fixture', output.getvalue())
        self.assertNotIn(b'private-build-fixture', output.getvalue())
        self.assertTrue(all(not any(value) for value in secrets.values()))

    def test_echo_enabled_or_repeated_prompt_never_receives_password(self):
        for repeat, reason in ((False, 'echo enabled'), (True, 'automatic retry refused')):
            program = '''
import os,termios
fd=os.open('/dev/tty',os.O_RDWR)
if REPEAT:
 mode=termios.tcgetattr(fd);mode[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(fd,termios.TCSANOW,mode)
os.write(fd,os.environ['SUDO_PROMPT'].encode())
os.read(fd,2048)
os.write(fd,os.environ['SUDO_PROMPT'].encode())
os.read(fd,2048)
'''.replace('REPEAT', repr(repeat))
            secrets = self.secret_values()
            output = io.BytesIO()
            with self.subTest(repeat=repeat), self.assertRaisesRegex(ValueError, reason):
                module.run_provision([sys.executable, '-I', '-c', program], secrets, output, timeout=10)
            self.assertNotIn(b'private-admin-fixture', output.getvalue())
            self.assertTrue(all(not any(value) for value in secrets.values()))

    def test_child_failure_status_is_preserved(self):
        self.assertEqual(module.run_provision([sys.executable, '-I', '-c', 'raise SystemExit(23)'], self.secret_values(), io.BytesIO(), timeout=10), 23)

    def test_failure_diagnostics_expose_only_allowlisted_reasons(self):
        for code, reason in module.FAILURE_REASONS.items():
            self.assertIn(reason, module.failure_message(module.ProvisionFailure(code)))
        for error in (ValueError('private-fixture'), OSError('private-fixture')):
            self.assertEqual(module.failure_message(error), 'Password-driven provisioning stopped. No password is printed or retried.')

    def test_output_redacts_secrets_split_across_read_boundaries(self):
        program = "import os,time; os.write(1,b'x'*4090+b'private-admin-'); time.sleep(0.05); os.write(1,b'fixture'+b'y'*4090+b'private-build-fixture')"
        output = io.BytesIO()
        self.assertEqual(module.run_provision([sys.executable, '-I', '-c', program], self.secret_values(), output, timeout=10), 0)
        self.assertNotIn(b'private-admin-', output.getvalue())
        self.assertNotIn(b'private-build-fixture', output.getvalue())
        self.assertEqual(output.getvalue().count(b'[redacted]'), 2)

    def test_actual_terminal_redaction_matches_whole_output_at_retained_boundary(self):
        # The first 4096-byte read emits at byte2048, placing each password
        # across that boundary. Vary reads too, including one byte at a time.
        for read_size in (1, 2048, 4096, 8192):
            for password_size in (5, 1024):
                secret = b'z' * password_size
                data = b'x' * 2045 + secret + b'y' * 4096 + b'other-secret'
                program = 'import os; os.write(1,' + repr(data) + ')'
                output = io.BytesIO()
                secrets = dict(administratorPassword=bytearray(secret), buildAccountPassword=bytearray(b'other-secret'))
                read = os.read
                with self.subTest(read_size=read_size, password_size=password_size), patch.object(module.os, 'read', side_effect=lambda fd, size: read(fd, min(size, read_size))):
                    self.assertEqual(module.run_provision([sys.executable, '-I', '-c', program], secrets, output, timeout=10), 0)
                self.assertEqual(output.getvalue(), b'x' * 2045 + b'[redacted]' + b'y' * 4096 + b'[redacted]')

    def test_password_substring_of_split_prompt_does_not_destroy_prompt_detection(self):
        program = '''
import os,termios,time
fd=os.open('/dev/tty',os.O_RDWR)
mode=termios.tcgetattr(fd);mode[3]&=~(termios.ECHO|termios.ECHONL);termios.tcsetattr(fd,termios.TCSANOW,mode)
os.write(fd,b'Dedicated account password');time.sleep(0.05);os.write(fd,b': ')
assert os.read(fd,100)==b'password\\n'
'''
        secrets = dict(administratorPassword=bytearray(b'administrator'), buildAccountPassword=bytearray(b'password'))
        self.assertEqual(module.run_provision([sys.executable, '-I', '-c', program], secrets, io.BytesIO(), timeout=10), 0)


if __name__ == '__main__':
    unittest.main()
