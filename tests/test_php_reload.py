from __future__ import annotations

import subprocess
import unittest
from unittest.mock import call, patch

import bento.services.php as php
from bento.utils.errors import StackError


class PhpReloadTests(unittest.TestCase):
    @patch.object(php, "info")
    @patch.object(php, "run")
    @patch.object(php, "service_running", return_value=True)
    def test_reload_suppresses_fpm_validation_output(self, _running, run, info) -> None:
        php.php_reload("php85", "shop")

        self.assertEqual(
            run.call_args_list,
            [
                call(["docker", "compose", "exec", "-T", "php85", "php-identity-sync", "shop"]),
                call(["docker", "compose", "exec", "-T", "php85", "php-fpm", "-tt"], capture=True),
                call(
                    ["docker", "compose", "exec", "-T", "php85", "sh", "-lc", "kill -USR2 1"],
                    capture=True,
                ),
            ],
        )
        info.assert_called_once_with("Reloaded php85")

    @patch.object(php, "run")
    @patch.object(php, "service_running", return_value=True)
    def test_reload_failure_is_concise(self, _running, run) -> None:
        run.side_effect = [
            None,
            subprocess.CalledProcessError(78, ["php-fpm", "-tt"], stderr="verbose config dump"),
        ]

        with self.assertRaisesRegex(StackError, "Failed to validate or reload php85"):
            php.php_reload("php85", "shop")


if __name__ == "__main__":
    unittest.main()
