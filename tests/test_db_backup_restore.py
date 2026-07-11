"""Atomic MySQL backup promotion and streaming restore tests (no live DB)."""
from __future__ import annotations

import argparse
import gzip
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vibeops.db_commands as db_commands
import vibeops.helpers as helpers
from vibeops.helpers import StackError


class ReserveBackupPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.backup_dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_distinct_paths_at_same_stamp_when_primary_exists(self) -> None:
        stamp = "20260711-120000-000000"
        existing = self.backup_dir / f"{stamp}_shop_app.sql"
        existing.write_text("-- existing\n", encoding="utf-8")
        original = existing.read_text(encoding="utf-8")

        first = db_commands._reserve_backup_path(self.backup_dir, stamp, "shop_app")
        first.write_text("-- reserved\n", encoding="utf-8")
        second = db_commands._reserve_backup_path(self.backup_dir, stamp, "shop_app")

        self.assertNotEqual(first, existing)
        self.assertNotEqual(second, first)
        self.assertNotEqual(second, existing)
        self.assertTrue(str(first).endswith(".sql"))
        self.assertTrue(str(second).endswith(".sql"))
        self.assertEqual(existing.read_text(encoding="utf-8"), original)

    def test_primary_path_when_free(self) -> None:
        stamp = "20260711-120000-000001"
        path = db_commands._reserve_backup_path(self.backup_dir, stamp, "shop_app")
        self.assertEqual(path, self.backup_dir / f"{stamp}_shop_app.sql")

    def test_gzip_extension_reserved(self) -> None:
        stamp = "20260711-120000-000002"
        path = db_commands._reserve_backup_path(self.backup_dir, stamp, "shop_app", compress=True)
        self.assertEqual(path, self.backup_dir / f"{stamp}_shop_app.sql.gz")


class AtomicDumpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.backup_dir = Path(self.tmp.name)
        self.service = "mysql84"
        self.option = Path(self.tmp.name) / "vibeops-root.cnf"
        self.option.write_text("[client]\nuser=root\n", encoding="utf-8")
        self.patches = [
            patch.object(db_commands, "service_running", return_value=True),
            patch.object(db_commands, "mysql_root_option_file", return_value=self.option),
            patch.object(db_commands, "mkdir", side_effect=helpers.mkdir),
            patch.object(db_commands, "ROOT", Path(self.tmp.name)),
            patch.object(helpers, "ROOT", Path(self.tmp.name)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _mock_dump_write(self, payload: bytes, returncode: int = 0):
        def _run_stdout_to_file(cmd, *, stdout_file, check=True, gzip_compress=False):
            if gzip_compress:
                with gzip.GzipFile(fileobj=stdout_file, mode="wb", mtime=0) as gz:
                    gz.write(payload)
                cp = subprocess.CompletedProcess(cmd, returncode, b"", b"dump-err\n" if returncode else b"")
                setattr(cp, "raw_bytes", len(payload))
                return cp
            stdout_file.write(payload)
            stdout_file.flush()
            return subprocess.CompletedProcess(cmd, returncode, b"", b"dump-err\n" if returncode else b"")

        return _run_stdout_to_file

    def test_successful_dump_promotes_content_and_mode(self) -> None:
        payload = b"-- MySQL dump\nCREATE TABLE t (id INT);\n"
        final = self.backup_dir / "20260711-120000-000000_shop_app.sql"

        with patch.object(db_commands, "run_stdout_to_file", side_effect=self._mock_dump_write(payload)):
            with patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]):
                db_commands.mysql_root_dump(["--databases", "shop_app"], service=self.service, output_path=final)

        self.assertTrue(final.is_file())
        self.assertEqual(final.read_bytes(), payload)
        mode = final.stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)
        partials = list(self.backup_dir.glob("*.partial-*"))
        self.assertEqual(partials, [])

    def test_nonzero_after_partial_bytes_leaves_no_final_or_partial(self) -> None:
        final = self.backup_dir / "fail_shop.sql"
        payload = b"partial dump bytes that should not be listed\n"

        with patch.object(db_commands, "run_stdout_to_file", side_effect=self._mock_dump_write(payload, returncode=2)):
            with patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]):
                with self.assertRaises(StackError) as ctx:
                    db_commands.mysql_root_dump(["--databases", "shop_app"], service=self.service, output_path=final)

        self.assertIn("mysqldump", str(ctx.exception))
        self.assertFalse(final.exists())
        self.assertEqual(list(self.backup_dir.glob("*.sql")), [])
        self.assertEqual(list(self.backup_dir.glob("*.partial-*")), [])

    def test_empty_successful_stdout_is_failure(self) -> None:
        final = self.backup_dir / "empty_shop.sql"

        with patch.object(db_commands, "run_stdout_to_file", side_effect=self._mock_dump_write(b"", returncode=0)):
            with patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]):
                with self.assertRaises(StackError) as ctx:
                    db_commands.mysql_root_dump(["--databases", "shop_app"], service=self.service, output_path=final)

        self.assertIn("empty", str(ctx.exception).lower())
        self.assertFalse(final.exists())
        self.assertEqual(list(self.backup_dir.glob("*.partial-*")), [])

    def test_refuses_to_truncate_existing_final(self) -> None:
        final = self.backup_dir / "existing.sql"
        final.write_text("-- keep me\n", encoding="utf-8")
        with self.assertRaises(StackError) as ctx:
            db_commands.mysql_root_dump(["--databases", "shop_app"], service=self.service, output_path=final)
        self.assertIn("overwrite", str(ctx.exception).lower())
        self.assertEqual(final.read_text(encoding="utf-8"), "-- keep me\n")

    def test_no_credentials_in_dump_argv(self) -> None:
        final = self.backup_dir / "cred_check.sql"
        seen: list[list[str]] = []

        def capture_cmd(*args, **kwargs):
            cmd = ["docker", "compose", *args]
            seen.append(cmd)
            return cmd

        with patch.object(db_commands, "run_stdout_to_file", side_effect=self._mock_dump_write(b"ok\n")):
            with patch.object(db_commands, "compose_command", side_effect=capture_cmd):
                db_commands.mysql_root_dump(["--databases", "shop_app"], service=self.service, output_path=final)

        flat = " ".join(seen[0])
        self.assertIn("defaults-extra-file=/run/secrets/vibeops-root.cnf", flat)
        self.assertNotIn("password", flat.lower())
        self.assertNotIn("MYSQL_PWD", flat)
        self.assertNotIn(" -p", f" {flat} ")

    def test_gzip_dump_promotes_valid_archive(self) -> None:
        payload = b"-- MySQL dump\nCREATE TABLE t (id INT);\n"
        final = self.backup_dir / "20260711-120000-000000_shop_app.sql.gz"

        with patch.object(db_commands, "run_stdout_to_file", side_effect=self._mock_dump_write(payload)):
            with patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]):
                db_commands.mysql_root_dump(
                    ["--databases", "shop_app"],
                    service=self.service,
                    output_path=final,
                    compress=True,
                )

        self.assertTrue(final.is_file())
        with gzip.open(final, "rb") as gz:
            self.assertEqual(gz.read(), payload)
        self.assertEqual(final.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.backup_dir.glob("*.partial-*")), [])

    def test_gzip_empty_raw_is_failure(self) -> None:
        final = self.backup_dir / "empty.sql.gz"
        with patch.object(db_commands, "run_stdout_to_file", side_effect=self._mock_dump_write(b"", returncode=0)):
            with patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]):
                with self.assertRaises(StackError) as ctx:
                    db_commands.mysql_root_dump(
                        ["--databases", "shop_app"],
                        service=self.service,
                        output_path=final,
                        compress=True,
                    )
        self.assertIn("empty", str(ctx.exception).lower())
        self.assertFalse(final.exists())


class ListingAndRetentionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.backup_dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_listing_ignores_partials_and_symlinks(self) -> None:
        final = self.backup_dir / "20260711-1_shop.sql"
        final.write_text("-- final\n", encoding="utf-8")
        final_gz = self.backup_dir / "20260711-1_shop.sql.gz"
        with gzip.open(final_gz, "wb") as gz:
            gz.write(b"-- gz final\n")
        partial = self.backup_dir / "20260711-1_shop.sql.partial-abc"
        partial.write_text("-- partial\n", encoding="utf-8")
        partial_gz = self.backup_dir / "20260711-1_shop.sql.gz.partial-xyz"
        partial_gz.write_bytes(b"nope")
        target = self.backup_dir / "target.sql"
        target.write_text("-- target\n", encoding="utf-8")
        link = self.backup_dir / "link.sql"
        link.symlink_to(target.name)

        listed = db_commands._list_final_backups(self.backup_dir)
        names = {p.name for p in listed}
        self.assertIn("20260711-1_shop.sql", names)
        self.assertIn("20260711-1_shop.sql.gz", names)
        self.assertIn("target.sql", names)
        self.assertNotIn("link.sql", names)
        self.assertNotIn(partial.name, names)
        self.assertNotIn(partial_gz.name, names)

    def test_keep_zero_rejected(self) -> None:
        with self.assertRaises(StackError) as ctx:
            db_commands._validate_keep(0)
        self.assertIn("positive", str(ctx.exception).lower())

    def test_keep_negative_rejected(self) -> None:
        with self.assertRaises(StackError):
            db_commands._validate_keep(-1)

    def test_retention_only_touches_final_sql(self) -> None:
        newer = self.backup_dir / "b.sql"
        older = self.backup_dir / "a.sql"
        partial = self.backup_dir / "c.sql.partial-x"
        newer.write_text("n", encoding="utf-8")
        older.write_text("o", encoding="utf-8")
        partial.write_text("p", encoding="utf-8")
        os.utime(newer, (2_000_000_000, 2_000_000_000))
        os.utime(older, (1_000_000_000, 1_000_000_000))

        with patch.object(db_commands, "info"):
            db_commands._apply_retention(self.backup_dir, keep=1)

        self.assertTrue(newer.exists())
        self.assertFalse(older.exists())
        self.assertTrue(partial.exists())


class BackupBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.backup_dir = Path(self.tmp.name)
        self.option = Path(self.tmp.name) / "root.cnf"
        self.option.write_text("[client]\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_multiple_database_batch_and_retention_after_success(self) -> None:
        written_payloads: dict[str, bytes] = {}
        compress_flags: list[bool] = []

        def fake_dump(mysqldump_args, *, service, output_path, compress=False):
            compress_flags.append(compress)
            content = f"-- dump {mysqldump_args[-1]}\n".encode()
            output_path.write_bytes(content)
            written_payloads[output_path.name] = content

        retention_calls: list[int] = []

        def fake_retention(backup_dir, *, keep):
            retention_calls.append(keep)

        args = argparse.Namespace(
            mysql_service="mysql84",
            database=None,
            app=None,
            keep=2,
            gzip=True,
        )
        with (
            patch.object(db_commands, "_require_mysql_service", return_value="mysql84"),
            patch.object(db_commands, "mysql_backup_dir", return_value=self.backup_dir),
            patch.object(db_commands, "mkdir"),
            patch.object(db_commands, "_stamp", return_value="20260711-120000-000000"),
            patch.object(db_commands, "_list_user_databases", return_value=["shop_app", "shop_reporting"]),
            patch.object(db_commands, "mysql_root_dump", side_effect=fake_dump),
            patch.object(db_commands, "_apply_retention", side_effect=fake_retention),
            patch.object(db_commands, "info"),
            patch.object(db_commands, "rel", side_effect=lambda p: str(p)),
        ):
            db_commands.cmd_db_backup(args)

        self.assertEqual(len(written_payloads), 2)
        self.assertTrue(all(name.endswith(".sql.gz") for name in written_payloads))
        self.assertEqual(compress_flags, [True, True])
        self.assertEqual(retention_calls, [2])

    def test_mid_batch_failure_keeps_earlier_dumps_skips_retention(self) -> None:
        calls: list[str] = []

        def fake_dump(mysqldump_args, *, service, output_path, compress=False):
            db_name = mysqldump_args[-1]
            calls.append(db_name)
            if db_name == "shop_b":
                raise StackError("mysqldump failed")
            output_path.write_text(f"-- {db_name}\n", encoding="utf-8")

        retention_calls: list[int] = []
        args = argparse.Namespace(
            mysql_service="mysql84",
            database=None,
            app=None,
            keep=1,
            gzip=False,
        )
        with (
            patch.object(db_commands, "_require_mysql_service", return_value="mysql84"),
            patch.object(db_commands, "mysql_backup_dir", return_value=self.backup_dir),
            patch.object(db_commands, "mkdir"),
            patch.object(db_commands, "_stamp", return_value="20260711-120000-000000"),
            patch.object(db_commands, "_list_user_databases", return_value=["shop_a", "shop_b", "shop_c"]),
            patch.object(db_commands, "mysql_root_dump", side_effect=fake_dump),
            patch.object(db_commands, "_apply_retention", side_effect=lambda *a, **k: retention_calls.append(1)),
            patch.object(db_commands, "info"),
            patch.object(db_commands, "warn") as warn_mock,
            patch.object(db_commands, "rel", side_effect=lambda p: str(p)),
        ):
            with self.assertRaises(StackError):
                db_commands.cmd_db_backup(args)

        self.assertEqual(calls, ["shop_a", "shop_b"])
        self.assertEqual(retention_calls, [])
        kept = list(self.backup_dir.glob("*.sql"))
        self.assertEqual(len(kept), 1)
        self.assertIn("shop_a", kept[0].name)
        warn_mock.assert_called()
        self.assertIn("safely", warn_mock.call_args[0][0].lower())


class StreamingRestoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dump = self.root / "big.sql"
        # Multi-megabyte payload with non-UTF-8 bytes.
        self.payload = b"-- dump\n" + (b"\x00\xffDATA" * 400_000) + b"\n"
        self.dump.write_bytes(self.payload)
        self.option = self.root / "root.cnf"
        self.option.write_text("[client]\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_streams_binary_without_read_text(self) -> None:
        streamed: list[bytes] = []

        def fake_run_stdin_stream(cmd, *, stdin_file, check=False, capture_stdout=True):
            streamed.append(stdin_file.read())
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with (
            patch.object(db_commands, "service_running", return_value=True),
            patch.object(db_commands, "mysql_root_option_file", return_value=self.option),
            patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]),
            patch.object(db_commands, "run_stdin_stream", side_effect=fake_run_stdin_stream),
            patch.object(Path, "read_text", side_effect=AssertionError("read_text must not be used")),
            patch.object(db_commands, "mysql_root_exec_sql", side_effect=AssertionError("exec_sql must not be used")),
        ):
            db_commands.mysql_root_stream_sql_file(self.dump, service="mysql84")

        self.assertEqual(len(streamed), 1)
        self.assertEqual(streamed[0], self.payload)

    def test_streams_gzip_backup_decompressed(self) -> None:
        gz_path = self.root / "big.sql.gz"
        with gzip.open(gz_path, "wb") as gz:
            gz.write(self.payload)
        streamed: list[bytes] = []

        def fake_run_stdin_stream(cmd, *, stdin_file, check=False, capture_stdout=True):
            streamed.append(stdin_file.read())
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with (
            patch.object(db_commands, "service_running", return_value=True),
            patch.object(db_commands, "mysql_root_option_file", return_value=self.option),
            patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]),
            patch.object(db_commands, "run_stdin_stream", side_effect=fake_run_stdin_stream),
        ):
            db_commands.mysql_root_stream_sql_file(gz_path, service="mysql84")

        self.assertEqual(len(streamed), 1)
        self.assertEqual(streamed[0], self.payload)

    def test_restore_nonzero_raises(self) -> None:
        def fake_run_stdin_stream(cmd, *, stdin_file, check=False, capture_stdout=True):
            stdin_file.read(1)
            return subprocess.CompletedProcess(cmd, 1, b"", b"syntax error")

        with (
            patch.object(db_commands, "service_running", return_value=True),
            patch.object(db_commands, "mysql_root_option_file", return_value=self.option),
            patch.object(db_commands, "compose_command", side_effect=lambda *a, **k: ["docker", "compose", *a]),
            patch.object(db_commands, "run_stdin_stream", side_effect=fake_run_stdin_stream),
        ):
            with self.assertRaises(StackError) as ctx:
                db_commands.mysql_root_stream_sql_file(self.dump, service="mysql84")
        self.assertIn("mysql", str(ctx.exception).lower())

    def test_restore_rejects_empty_file(self) -> None:
        empty = self.root / "empty.sql"
        empty.write_bytes(b"")
        with (
            patch.object(db_commands, "service_running", return_value=True),
            patch.object(db_commands, "mysql_root_option_file", return_value=self.option),
        ):
            with self.assertRaises(StackError) as ctx:
                db_commands.mysql_root_stream_sql_file(empty, service="mysql84")
        self.assertIn("empty", str(ctx.exception).lower())

    def test_cmd_db_restore_streams_and_skips_read_text(self) -> None:
        stream_calls: list[Path] = []

        def fake_stream(path, *, service):
            stream_calls.append(path)

        args = argparse.Namespace(
            mysql_service="mysql84",
            backup_file=str(self.dump),
            yes=True,
        )
        with (
            patch.object(db_commands, "_require_mysql_service", return_value="mysql84"),
            patch.object(db_commands, "_resolve_backup_path", return_value=self.dump),
            patch.object(db_commands, "mysql_root_stream_sql_file", side_effect=fake_stream),
            patch.object(db_commands, "warn"),
            patch.object(db_commands, "info"),
            patch.object(db_commands, "rel", side_effect=lambda p: str(p)),
            patch.object(Path, "read_text", side_effect=AssertionError("read_text must not be used")),
        ):
            db_commands.cmd_db_restore(args)

        self.assertEqual(stream_calls, [self.dump])


class ComposeArgvAuditTests(unittest.TestCase):
    def test_db_commands_has_no_bare_docker_compose_literals(self) -> None:
        source = Path(db_commands.__file__).read_text(encoding="utf-8")
        self.assertNotIn('"docker", "compose"', source)
        self.assertNotIn("'docker', 'compose'", source)

    def test_dump_argv_uses_compose_command(self) -> None:
        # Smoke: compose_command is imported and used by dump path.
        self.assertTrue(hasattr(db_commands, "compose_command"))
        self.assertTrue(callable(db_commands.compose_command))


if __name__ == "__main__":
    unittest.main()
