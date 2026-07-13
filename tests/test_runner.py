from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import bento.commands.runtime_commands as runtime_commands
import bento.commands.worker_commands as worker_commands
import bento.services.runner as runner
from bento.utils.errors import StackError
from bento.utils.paths import RenderContext


def _db() -> dict:
    return {
        "apps": {"shop": {"name": "shop", "uid": 10001, "php_version": "8.5"}},
        "crons": {
            "shop/schedule": {
                "app": "shop",
                "job_name": "schedule",
                "php_version": "8.5",
            }
        },
        "workers": {
            "shop/queue": {
                "app": "shop",
                "name": "queue",
                "php_version": "8.5",
                "workdir": "/home/shop/www",
                "command": ["php", "artisan", "queue:work", "--max-time=3600"],
                "stop_timeout": 120,
                "enabled": True,
            }
        },
    }


class RunnerRenderTests(unittest.TestCase):
    def test_supervisor_runs_cron_and_worker_directly_as_app_user(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ctx = RenderContext(Path(tmp) / "generated", Path(tmp) / "secrets")
            path = runner.render_runner_programs(_db(), "8.5", ctx)
            text = path.read_text()
        self.assertIn("[program:system-cron]", text)
        self.assertIn("[program:cron-shop]", text)
        self.assertIn("[program:worker-shop-queue]", text)
        self.assertIn("command=php artisan queue:work --max-time=3600", text)
        self.assertIn("user=shop", text)
        self.assertIn("directory=/home/shop/www", text)
        # Flat programs: no process group, so update does not recycle siblings.
        self.assertNotIn("[group:app-shop]", text)
        self.assertNotIn("php-app-run", text)

    def test_percent_is_escaped_for_supervisor_interpolation(self) -> None:
        db = _db()
        db["workers"]["shop/queue"]["command"] = ["node", "worker.js", "50%"]
        with tempfile.TemporaryDirectory() as tmp:
            ctx = RenderContext(Path(tmp) / "generated", Path(tmp) / "secrets")
            text = runner.render_runner_programs(db, "8.5", ctx).read_text()
        self.assertIn("50%%", text)

    def test_worker_workdir_cannot_escape_app_home(self) -> None:
        worker = _db()["workers"]["shop/queue"]
        worker["workdir"] = "/home/other/www"
        with self.assertRaises(StackError):
            runner.normalize_worker(worker)


class WorkerCommandTests(unittest.TestCase):
    def test_create_records_argv_and_targets_only_runner(self) -> None:
        db = _db()
        db["workers"] = {}
        lock = MagicMock()
        lock.return_value.__enter__ = MagicMock(return_value=None)
        lock.return_value.__exit__ = MagicMock(return_value=False)
        args = argparse.Namespace(
            app_name="shop",
            worker_name="queue",
            php=None,
            workdir=None,
            stop_timeout=180,
            worker_command=["--", "php", "artisan", "queue:work"],
        )
        with (
            patch.object(worker_commands, "cron_state_lock", lock),
            patch.object(worker_commands, "load_db", return_value=db),
            patch.object(worker_commands, "save_db") as save,
            patch.object(worker_commands, "upsert_timestamp"),
            patch.object(worker_commands, "info"),
            patch.object(runtime_commands, "apply_generated_config", return_value=[]) as apply,
        ):
            worker_commands.cmd_worker_create(args)
        self.assertEqual(db["workers"]["shop/queue"]["command"], ["php", "artisan", "queue:work"])
        self.assertEqual(db["workers"]["shop/queue"]["stop_timeout"], 180)
        self.assertEqual(set(apply.call_args.kwargs["service_targets"]), {"runner"})
        save.assert_called_once_with(db)

    def test_restart_addresses_named_supervisor_child(self) -> None:
        with (
            patch.object(worker_commands, "load_db", return_value=_db()),
            patch.object(worker_commands, "service_running", return_value=True),
            patch.object(worker_commands, "run") as run,
        ):
            worker_commands.cmd_worker_control(
                argparse.Namespace(worker_action="restart", app_name="shop", worker_name="queue")
            )
        command = run.call_args.args[0]
        self.assertIn("php85-runner", command)
        self.assertEqual(command[-2:], ["restart", "worker-shop-queue"])

    def test_app_wide_control_expands_workers_from_state(self) -> None:
        db = _db()
        db["workers"]["shop/horizon"] = {
            "app": "shop",
            "name": "horizon",
            "php_version": "8.5",
            "workdir": "/home/shop/www",
            "command": ["php", "artisan", "horizon"],
            "stop_timeout": 120,
            "enabled": True,
        }
        with (
            patch.object(worker_commands, "load_db", return_value=db),
            patch.object(worker_commands, "service_running", return_value=True),
            patch.object(worker_commands, "run") as run,
        ):
            worker_commands.cmd_worker_control(
                argparse.Namespace(worker_action="status", app_name="shop", worker_name=None)
            )
        command = run.call_args.args[0]
        self.assertEqual(command[-3:], ["status", "worker-shop-horizon", "worker-shop-queue"])

    def test_worker_targets_are_flat_program_names(self) -> None:
        self.assertEqual(runner.worker_program_name("shop", "queue"), "worker-shop-queue")
        self.assertEqual(runner.cron_program_name("shop"), "cron-shop")
        self.assertEqual(
            runner.worker_targets(_db(), "shop"),
            ["worker-shop-queue"],
        )


if __name__ == "__main__":
    unittest.main()
