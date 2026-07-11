from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vibeops.services.cron_runtime as cron_runtime
import vibeops.helpers as helpers
from vibeops.commands.cron_commands import cron_render_values, validate_schedule
from vibeops.utils.errors import StackError


class CronValidationTests(unittest.TestCase):
    def test_valid_schedule(self) -> None:
        self.assertEqual(validate_schedule("*/5 * * * *"), "*/5 * * * *")
        self.assertEqual(validate_schedule("@hourly"), "@hourly")

    def test_schedule_rejects_shell_syntax(self) -> None:
        with self.assertRaises(StackError):
            validate_schedule("* * * * *; touch /tmp/bad")

    def test_workdir_is_app_bounded(self) -> None:
        self.assertEqual(helpers.validate_cron_workdir("shop", "/home/shop/www"), "/home/shop/www")
        for path in ("/tmp", "/home/other/www", "/home/shop/www/../private"):
            with self.subTest(path=path), self.assertRaises(StackError):
                helpers.validate_cron_workdir("shop", path)

    def test_render_values_include_runtime_policy(self) -> None:
        values = cron_render_values({
            "app": "shop",
            "job_name": "schedule",
            "php_version": "8.5",
            "schedule": "* * * * *",
            "command": "php artisan schedule:run",
            "workdir": "/home/shop/www",
            "output": "file",
            "timeout": 50,
            "lock": "artisan",
            "timezone": "UTC",
        })
        self.assertEqual(values["PHP_SERVICE"], "php85-cron")
        self.assertEqual(values["OUTPUT"], "file")
        self.assertEqual(values["TIMEOUT"], 50)
        self.assertEqual(values["QUOTED_LOCK"], "artisan")


class CronRenderTests(unittest.TestCase):
    def test_empty_crontab_has_daily_maintenance_job(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(cron_runtime, "CRON_RUNTIME_DIR", Path(tmp)):
            combined = cron_runtime.rebuild_supercronic_crontab("8.5")
            content = combined.read_text()
            self.assertNotIn("/bin/true", content)
            self.assertIn("/usr/sbin/logrotate", content)
            rotation = combined.parent / ".logrotate.conf"
            rotation_content = rotation.read_text()
            self.assertIn("cron-php85-cron-*.log", rotation_content)
            self.assertIn("fpm-php-8.5.error.log", rotation_content)
            self.assertIn("dateext", rotation_content)
            self.assertIn("dateformat -%Y-%m-%d", rotation_content)

    def test_nonempty_crontab_does_not_add_dummy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.object(cron_runtime, "CRON_RUNTIME_DIR", Path(tmp)):
            jobs = cron_runtime.cron_jobs_dir_for("8.5")
            jobs.mkdir(parents=True)
            (jobs / "shop.cron").write_text("* * * * * /bin/echo ok\n")
            content = cron_runtime.rebuild_supercronic_crontab("8.5").read_text()
            self.assertIn("/bin/echo ok", content)
            self.assertNotIn("/bin/true", content)


if __name__ == "__main__":
    unittest.main()
