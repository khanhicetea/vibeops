"""Host-triggered stack maintenance and cron registration."""
from __future__ import annotations

import argparse
import unittest
from unittest.mock import patch

from bento.commands import maintenance_commands
from bento.commands.parser import build_parser
from bento.utils.errors import StackError


class MaintenanceCliTests(unittest.TestCase):
    def test_command_defaults_to_run(self) -> None:
        parser = build_parser()
        direct = parser.parse_args(["maintenance"])
        self.assertEqual(direct.maintenance_action, None)
        self.assertIs(direct.func, maintenance_commands.cmd_maintenance)
        setup = parser.parse_args(["maintenance", "setup-cron", "--schedule", "0 4 * * *"])
        self.assertEqual(setup.maintenance_action, "setup-cron")
        self.assertEqual(setup.schedule, "0 4 * * *")

    def test_run_executes_logrotate_inside_nginx(self) -> None:
        with (
            patch.object(maintenance_commands, "docker_available", return_value=True),
            patch.object(maintenance_commands, "service_running", return_value=True),
            patch.object(maintenance_commands, "compose_prefix", return_value=["docker", "compose"]),
            patch.object(maintenance_commands, "run") as run,
            patch.object(maintenance_commands, "info"),
        ):
            maintenance_commands.run_maintenance(force=True)

        run.assert_called_once_with([
            "docker", "compose", "exec", "-T", "nginx", "logrotate",
            "--state", "/var/log/nginx/.bento-logrotate.status", "--force",
            "/etc/logrotate.d/bento-nginx",
        ])

    def test_run_requires_running_nginx(self) -> None:
        with (
            patch.object(maintenance_commands, "docker_available", return_value=True),
            patch.object(maintenance_commands, "service_running", return_value=False),
            self.assertRaisesRegex(StackError, "nginx must be running"),
        ):
            maintenance_commands.run_maintenance()

    def test_setup_cron_replaces_managed_block_and_preserves_other_jobs(self) -> None:
        existing = "0 1 * * * /usr/local/bin/backup\n# BEGIN bento maintenance\nold\n# END bento maintenance\n"
        read_result = argparse.Namespace(returncode=0, stdout=existing, stderr="")
        install_result = argparse.Namespace(returncode=0, stdout="", stderr="")
        with (
            patch.object(maintenance_commands, "command_exists", return_value=True),
            patch.object(maintenance_commands, "run", side_effect=[read_result, install_result]) as run,
            patch.object(maintenance_commands, "info"),
        ):
            maintenance_commands.setup_cron("17 3 * * *")

        installed = run.call_args_list[1].kwargs["input_text"]
        self.assertIn("0 1 * * * /usr/local/bin/backup", installed)
        self.assertEqual(installed.count("# BEGIN bento maintenance"), 1)
        self.assertIn("17 3 * * *", installed)
        self.assertIn("manage.py maintenance", installed)

    def test_setup_cron_rejects_non_five_field_schedule(self) -> None:
        with self.assertRaisesRegex(StackError, "exactly 5 fields"):
            maintenance_commands.setup_cron("@daily")


if __name__ == "__main__":
    unittest.main()
