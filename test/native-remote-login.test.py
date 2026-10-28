"""macOS service ACL admission through its existing commands and effective policy."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('remote_login', Path(__file__).resolve().parents[1] / 'deploy/mac-build/remote_login.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

POLICY = '''authorizedkeysfile /Library/Partitura/NativeBuild/authorized_keys
forcecommand /usr/bin/python3 /Library/Partitura/NativeBuild/broker.py
passwordauthentication no
kbdinteractiveauthentication no
authenticationmethods publickey
allowtcpforwarding no
allowagentforwarding no
x11forwarding no
permittty no
permituserenvironment no
'''


class RemoteLoginTests(unittest.TestCase):
    def runner(self, policy=POLICY, groups='staff', missing=False, already=False):
        self.commands = []
        def run(argv, **kwargs):
            self.commands.append(argv)
            self.assertEqual(kwargs['timeout'], 15)
            output, error, status = '', '', 0
            if argv[0].endswith('/id'): output = groups
            elif argv[0].endswith('/sshd'): output = policy
            elif argv[0].endswith('/dscl') and missing:
                error, status = 'eDSRecordNotFound', 185
            elif 'checkmember' in argv:
                added = any('edit' in command for command in self.commands)
                if not already and not added:
                    output, status = 'no builder is NOT a member of com.apple.access_ssh\n', 67
            result = subprocess.CompletedProcess(argv, status, output, error)
            if kwargs.get('check'): result.check_returncode()
            return result
        return run

    def test_check_is_read_only_and_apply_adds_only_the_named_account(self):
        self.assertIn('approval', module.admit('builder', run=self.runner()))
        self.assertFalse(any('edit' in command for command in self.commands))
        self.assertIn('verified', module.admit('builder', True, self.runner()))
        edits = [command for command in self.commands if 'edit' in command]
        self.assertEqual(edits, [['/usr/sbin/dseditgroup', '-o', 'edit', '-a', 'builder', '-t', 'user', 'com.apple.access_ssh']])
        self.assertIn('checkmember', self.commands[-1])

    def test_refuses_unrestricted_policy_or_privileged_account_before_membership(self):
        for policy, groups in ((POLICY.replace('forcecommand /usr/bin/python3 /Library/Partitura/NativeBuild/broker.py', 'forcecommand none'), 'staff'), (POLICY.replace('permittty no', 'permittty yes'), 'staff'), (POLICY, 'staff admin')):
            with self.subTest(policy=policy, groups=groups), self.assertRaises(ValueError):
                module.admit('builder', True, self.runner(policy, groups))
            self.assertFalse(any('edit' in command for command in self.commands))

    def test_preserves_absent_acl_and_existing_membership(self):
        for options in ({'missing': True}, {'already': True}):
            module.admit('builder', True, self.runner(**options))
            self.assertFalse(any('edit' in command for command in self.commands))

    def test_extended_keepalive_policy_does_not_broaden_remote_login_admission(self):
        policy = POLICY + 'clientaliveinterval 15\nclientalivecountmax 3\n'
        module.admit('builder', True, self.runner(policy=policy))
        edits = [command for command in self.commands if 'edit' in command]
        self.assertEqual(edits, [['/usr/sbin/dseditgroup', '-o', 'edit', '-a', 'builder', '-t', 'user', 'com.apple.access_ssh']])
        self.assertFalse(any('systemsetup' in ' '.join(command) for command in self.commands))

    def test_rejects_account_injection(self):
        for account in ('root', '../builder', 'builder;id', ''):
            with self.assertRaises(ValueError):
                module.admit(account, True, self.runner())
            self.assertEqual(self.commands, [])

    def test_accepts_macos_keyword_case_without_changing_path_case(self):
        policy = '\n'.join(key.title() + ' ' + value for key, value in (line.split(' ', 1) for line in POLICY.splitlines()))
        self.assertIn('verified', module.admit('builder', True, self.runner(policy=policy)))
        with self.assertRaises(ValueError):
            module.admit('builder', True, self.runner(policy=policy.replace('/Library/Partitura', '/library/partitura')))


if __name__ == '__main__':
    unittest.main()
