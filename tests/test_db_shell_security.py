"""Regression tests: app db shell must not put passwords in host argv or logs."""
from __future__ import annotations

import argparse
import io
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vibeops.commands.db_commands as db_commands
from vibeops.services.mysql import mysql_client_option_file_content
from vibeops.utils.errors import StackError

SENTINEL = "DO_NOT_LEAK_TEST_SECRET"


def _contains_sentinel(obj: object, *, seen: set[int] | None = None) -> bool:
    """Recursively search lists/tuples/dicts/strings for the sentinel secret."""
    if seen is None:
        seen = set()
    oid = id(obj)
    if oid in seen:
        return False
    seen.add(oid)
    if isinstance(obj, (str, bytes)):
        text = obj.decode("utf-8", errors="replace") if isinstance(obj, bytes) else obj
        return SENTINEL in text
    if isinstance(obj, dict):
        return any(_contains_sentinel(k, seen=seen) or _contains_sentinel(v, seen=seen) for k, v in obj.items())
    if isinstance(obj, (list, tuple, set)):
        return any(_contains_sentinel(item, seen=seen) for item in obj)
    if isinstance(obj, BaseException):
        return _contains_sentinel(str(obj), seen=seen) or _contains_sentinel(getattr(obj, "args", ()), seen=seen)
    return False


class MysqlOptionFileContentTests(unittest.TestCase):
    def test_single_client_section_and_quoted_fields(self) -> None:
        body = mysql_client_option_file_content(user="shop", password="plain")
        self.assertEqual(body.count("[client]"), 1)
        self.assertIn('user="shop"', body)
        self.assertIn('password="plain"', body)
        self.assertTrue(body.endswith("\n"))
        # Exactly three content lines + trailing newline for user/password case.
        lines = [ln for ln in body.splitlines() if ln.strip()]
        self.assertEqual(lines[0], "[client]")
        self.assertEqual(len(lines), 3)

    def test_escapes_backslash_and_double_quote_in_password(self) -> None:
        body = mysql_client_option_file_content(
            user="shop",
            password=r'a\b"c',
        )
        self.assertIn(r'password="a\\b\"c"', body)
        # Escaping must not introduce an extra unquoted line from the password.
        self.assertEqual(body.count("\n"), 3)  # three lines + final newline => 3 separators
        self.assertNotIn('\npassword=', body.split("password=", 1)[1])  # value stays on one line

    def test_username_specials_are_quoted_not_injected(self) -> None:
        # APP_NAME_RE usernames are constrained; still ensure quoting is structural.
        body = mysql_client_option_file_content(user="shop_app", password="x")
        self.assertIn('user="shop_app"', body)
        self.assertEqual(body.count("[client]"), 1)

    def test_protocol_socket_for_root_style_content(self) -> None:
        body = mysql_client_option_file_content(
            user="root",
            password=r'p"w\d',
            protocol="socket",
        )
        self.assertIn("protocol=socket", body)
        self.assertIn(r'password="p\"w\\d"', body)

    def test_rejects_newline_in_password(self) -> None:
        with self.assertRaises(StackError):
            mysql_client_option_file_content(user="shop", password="bad\nline")

    def test_rejects_invalid_protocol(self) -> None:
        with self.assertRaises(StackError):
            mysql_client_option_file_content(user="root", password="x", protocol="socket;rm")


class DbShellSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.service = "mysql84"
        self.username = "shop"
        self.cred_dir = self.home / self.username / ".credentials"
        self.cred_dir.mkdir(parents=True)
        self.cred_path = self.cred_dir / f"{self.service}.env"
        self.cred_path.write_text(
            f"MYSQL_USER={self.username}\nMYSQL_PASSWORD={SENTINEL}\n",
            encoding="utf-8",
        )
        self.option = self.root / "secrets" / "mysql" / f"{self.service}-root.cnf"
        self.option.parent.mkdir(parents=True)
        self.option.write_text('[client]\nuser="root"\npassword="rootpw"\n', encoding="utf-8")

        self.calls: list[dict] = []
        self.cleanup_returncode = 0
        self.setup_returncode = 0
        self.client_returncode = 0
        self.setup_should_raise: BaseException | None = None
        self.client_should_raise: BaseException | None = None
        self.cleanup_should_raise: BaseException | None = None
        self.info_out = io.StringIO()
        self.warn_out = io.StringIO()

        def compose_command(*args: str, root=None, **kwargs):
            return ["docker", "compose", *args]

        def fake_run(cmd, *, input_text=None, check=True, capture=False):
            record = {"fn": "run", "cmd": list(cmd), "input_text": input_text, "check": check, "capture": capture}
            self.calls.append(record)
            if _contains_sentinel(cmd):
                raise AssertionError(f"sentinel appeared in run argv: {cmd!r}")
            # Classify by compose args: exec -T ... umask / rm / interactive has no -T before service.
            flat = " ".join(cmd)
            if "umask 077" in flat and "cat >" in flat:
                if self.setup_should_raise:
                    raise self.setup_should_raise
                if self.setup_returncode != 0:
                    return subprocess.CompletedProcess(cmd, self.setup_returncode, "", "setup failed")
                # Confirm secret travels only via stdin content, not argv.
                self.assertIsNotNone(input_text)
                self.assertIn(SENTINEL, input_text or "")
                return subprocess.CompletedProcess(cmd, 0, "", "")
            if "rm -f" in flat:
                if self.cleanup_should_raise:
                    raise self.cleanup_should_raise
                return subprocess.CompletedProcess(cmd, self.cleanup_returncode, "", "cleanup err" if self.cleanup_returncode else "")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        def fake_subprocess_run(cmd, **kwargs):
            record = {"fn": "subprocess.run", "cmd": list(cmd), "kwargs": dict(kwargs)}
            self.calls.append(record)
            if _contains_sentinel(cmd) or _contains_sentinel(kwargs):
                raise AssertionError(f"sentinel appeared in subprocess.run: cmd={cmd!r} kwargs={kwargs!r}")
            if self.client_should_raise:
                raise self.client_should_raise
            return subprocess.CompletedProcess(cmd, self.client_returncode, None, None)

        self.patches = [
            patch.object(db_commands, "service_running", return_value=True),
            patch.object(db_commands, "mysql_root_option_file", return_value=self.option),
            patch.object(db_commands, "HOME_DIR", self.home),
            patch.object(db_commands, "ROOT", self.root),
            patch.object(db_commands, "compose_command", side_effect=compose_command),
            patch.object(db_commands, "run", side_effect=fake_run),
            patch.object(db_commands.subprocess, "run", side_effect=fake_subprocess_run),
            patch.object(db_commands, "info", side_effect=lambda m: self.info_out.write(str(m) + "\n")),
            patch.object(db_commands, "warn", side_effect=lambda m: self.warn_out.write(str(m) + "\n")),
            # Stable remote path for assertions.
            patch.object(db_commands, "_ephemeral_client_option_path", return_value="/run/vibeops-client-deadbeef.cnf"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _assert_no_sentinel_in_output(self) -> None:
        blob = self.info_out.getvalue() + self.warn_out.getvalue()
        self.assertNotIn(SENTINEL, blob)
        for call in self.calls:
            self.assertFalse(_contains_sentinel(call["cmd"]), msg=repr(call["cmd"]))
            # input_text may intentionally carry the secret for staging only.
            if call.get("fn") == "run" and call.get("input_text") and SENTINEL in (call.get("input_text") or ""):
                continue
            self.assertFalse(_contains_sentinel(call), msg=repr(call))

    def _args(self, **kwargs) -> argparse.Namespace:
        base = {
            "user": self.username,
            "mysql_service": self.service,
        }
        base.update(kwargs)
        return argparse.Namespace(**base)

    def test_missing_credentials_fails_without_docker(self) -> None:
        self.cred_path.unlink()
        with self.assertRaises(StackError) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertNotIn(SENTINEL, str(ctx.exception))
        self.assertEqual(self.calls, [])

    def test_missing_password_key_fails(self) -> None:
        self.cred_path.write_text(f"MYSQL_USER={self.username}\n", encoding="utf-8")
        with self.assertRaises(StackError) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertNotIn(SENTINEL, str(ctx.exception))
        self.assertEqual(self.calls, [])

    def test_happy_path_stages_client_and_cleans_up_once(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertEqual(ctx.exception.code, 0)

        kinds = []
        for call in self.calls:
            flat = " ".join(call["cmd"])
            if "umask 077" in flat:
                kinds.append("setup")
                self.assertIn("-T", call["cmd"])
                self.assertIn("/run/vibeops-client-deadbeef.cnf", flat)
                self.assertIn(SENTINEL, call.get("input_text") or "")
                self.assertNotIn(SENTINEL, flat)
            elif call["fn"] == "subprocess.run" and "defaults-extra-file=" in flat:
                kinds.append("client")
                self.assertNotIn("-T", call["cmd"])  # interactive TTY exec
                self.assertIn("--defaults-extra-file=/run/vibeops-client-deadbeef.cnf", flat)
                self.assertNotIn(SENTINEL, flat)
                self.assertNotIn("MYSQL_PWD", flat)
            elif "rm -f" in flat:
                kinds.append("cleanup")
                self.assertIn("-T", call["cmd"])
                self.assertIn("/run/vibeops-client-deadbeef.cnf", flat)

        self.assertEqual(kinds, ["setup", "client", "cleanup"])
        self._assert_no_sentinel_in_output()

    def test_client_nonzero_exit_propagates_after_cleanup(self) -> None:
        self.client_returncode = 42
        with self.assertRaises(SystemExit) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertEqual(ctx.exception.code, 42)
        flats = [" ".join(c["cmd"]) for c in self.calls]
        self.assertTrue(any("umask 077" in f for f in flats))
        self.assertTrue(any("rm -f" in f for f in flats))
        self._assert_no_sentinel_in_output()

    def test_setup_failure_prevents_client_and_skips_cleanup(self) -> None:
        self.setup_returncode = 7
        with self.assertRaises(StackError) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertNotIn(SENTINEL, str(ctx.exception))
        flats = [" ".join(c["cmd"]) for c in self.calls]
        self.assertTrue(any("umask 077" in f for f in flats))
        self.assertFalse(any(c["fn"] == "subprocess.run" for c in self.calls))
        self.assertFalse(any("rm -f" in f for f in flats))
        self._assert_no_sentinel_in_output()

    def test_keyboard_interrupt_still_cleans_up(self) -> None:
        self.client_should_raise = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            db_commands.cmd_db_shell(self._args())
        flats = [" ".join(c["cmd"]) for c in self.calls]
        self.assertTrue(any("umask 077" in f for f in flats))
        self.assertTrue(any("rm -f" in f for f in flats))
        self._assert_no_sentinel_in_output()

    def test_system_exit_from_client_still_cleans_up(self) -> None:
        self.client_should_raise = SystemExit(9)
        with self.assertRaises(SystemExit) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertEqual(ctx.exception.code, 9)
        flats = [" ".join(c["cmd"]) for c in self.calls]
        self.assertTrue(any("rm -f" in f for f in flats))
        self._assert_no_sentinel_in_output()

    def test_cleanup_failure_warns_without_masking_client_exit(self) -> None:
        self.client_returncode = 3
        self.cleanup_returncode = 1
        with self.assertRaises(SystemExit) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertEqual(ctx.exception.code, 3)
        warn_text = self.warn_out.getvalue()
        self.assertIn("could not remove ephemeral MySQL client option file", warn_text)
        self.assertNotIn(SENTINEL, warn_text)
        self._assert_no_sentinel_in_output()

    def test_cleanup_exception_warns_without_masking_client_exit(self) -> None:
        self.client_returncode = 5
        self.cleanup_should_raise = RuntimeError("boom")
        with self.assertRaises(SystemExit) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertEqual(ctx.exception.code, 5)
        self.assertIn("could not remove ephemeral", self.warn_out.getvalue())
        self._assert_no_sentinel_in_output()

    def test_password_with_quotes_and_backslashes_only_on_stdin(self) -> None:
        special = f'{SENTINEL}\\and"quote'
        self.cred_path.write_text(
            f"MYSQL_USER={self.username}\nMYSQL_PASSWORD={special}\n",
            encoding="utf-8",
        )
        # Override sentinel check for this specialized secret form.
        with patch.object(db_commands, "run") as run_mock, patch.object(
            db_commands.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
        ):
            staged: list[str] = []

            def run_side_effect(cmd, *, input_text=None, check=True, capture=False):
                flat = " ".join(cmd)
                self.assertNotIn(special, flat)
                self.assertNotIn(SENTINEL, flat)
                if "umask 077" in flat:
                    staged.append(input_text or "")
                    return subprocess.CompletedProcess(cmd, 0, "", "")
                if "rm -f" in flat:
                    return subprocess.CompletedProcess(cmd, 0, "", "")
                return subprocess.CompletedProcess(cmd, 0, "", "")

            run_mock.side_effect = run_side_effect
            with self.assertRaises(SystemExit):
                db_commands.cmd_db_shell(self._args())

        self.assertEqual(len(staged), 1)
        self.assertIn(r'\\', staged[0] or "")  # escaped backslash in option file
        self.assertIn(r'\"', staged[0] or "")
        # Raw secret characters appear only inside the escaped option-file body on stdin.
        self.assertIn(SENTINEL, staged[0] or "")

    def test_root_shell_unchanged_path(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            db_commands.cmd_db_shell(self._args(user=None))
        self.assertEqual(ctx.exception.code, 0)
        self.assertEqual(len(self.calls), 1)
        flat = " ".join(self.calls[0]["cmd"])
        self.assertIn("defaults-extra-file=/run/secrets/vibeops-root.cnf", flat)
        self.assertNotIn("MYSQL_PWD", flat)

    def test_db_password_fallback_key(self) -> None:
        self.cred_path.write_text(
            f"DB_PASSWORD={SENTINEL}\n",
            encoding="utf-8",
        )
        with self.assertRaises(SystemExit) as ctx:
            db_commands.cmd_db_shell(self._args())
        self.assertEqual(ctx.exception.code, 0)
        setup = next(c for c in self.calls if c["fn"] == "run" and "umask 077" in " ".join(c["cmd"]))
        self.assertIn(SENTINEL, setup["input_text"] or "")
        self._assert_no_sentinel_in_output()


class SourceAuditTests(unittest.TestCase):
    def test_no_password_valued_mysql_pwd_argv_construction(self) -> None:
        root = Path(__file__).resolve().parents[1] / "vibeops"
        offenders: list[str] = []
        pattern = re.compile(r'MYSQL_PWD=\{|f["\']MYSQL_PWD=|f["\']DB_PASSWORD=|f["\']MYSQL_PASSWORD=')
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for i, line in enumerate(text.splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{path}:{i}:{line.strip()}")
        self.assertEqual(offenders, [], msg="password-valued argv construction found:\n" + "\n".join(offenders))


if __name__ == "__main__":
    unittest.main()
