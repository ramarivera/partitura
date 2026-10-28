from native_host_contract_support import *

class PartituraNativeHostInstallTest(NativeHostFixture, unittest.TestCase):
    def test_failed_update_restores_all_managed_files_and_retry_passes_preflight(self):
        for failure in ('sshd', 'bootstrap', 'readback', 'loopback'):
            for was_loaded in (False, True):
                with self.subTest(failure=failure, was_loaded=was_loaded):
                    self.exercise_install_rollback(failure, was_loaded)


    def test_restored_payload_drift_keeps_installer_fences_in_real_main(self):
        self.exercise_install_rollback('sshd', False, corrupt_restored=True)

    def test_failed_update_preserves_existing_maintenance_log(self):
        for failure in ('sshd', 'bootstrap', 'readback', 'loopback'):
            with self.subTest(failure=failure):
                self.exercise_install_rollback(failure, True, existing_log=True)


    def test_installer_validates_live_sshd_and_restores_the_dropin_on_failure(self):
        installer = (ROOT / "deploy/mac-build/install-host.sh").read_text()
        swap = installer.index('/bin/mv -f "$dropin.new" "$dropin"')
        live_check = installer.index('/usr/sbin/sshd -t', swap)
        completion = installer.index("completed=1", live_check)
        self.assertLess(swap, live_check)
        self.assertLess(live_check, completion)
        manifest_backup = installer.index(
            "backup_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json"
        )
        manifest_install = installer.index('atomic_install "$stage/managed-files.json"')
        self.assertLess(manifest_backup, manifest_install)
        self.assertIn(
            "restore_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json",
            installer,
        )



if __name__ == '__main__':
    unittest.main()
