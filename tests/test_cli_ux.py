"""CLI UX: interactive cancellation and secret input handling."""
from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr
from unittest import mock

from vibeops.cli import main
from vibeops.errors import cli_flag_present, warn_password_cli_flag
from vibeops.parser import build_parser
from vibeops.runtime_commands import prompt_password


class CliCancellationTests(unittest.TestCase):
    def test_keyboard_interrupt_returns_130_without_traceback(self) -> None:
        with mock.patch("vibeops.cli.build_parser") as build:
            parser = mock.Mock()
            args = mock.Mock()
            args.func = mock.Mock(side_effect=KeyboardInterrupt)
            parser.parse_args.return_value = args
            build.return_value = parser
            err = io.StringIO()
            with redirect_stderr(err):
                code = main(["status"])
        self.assertEqual(code, 130)
        self.assertIn("Interrupted", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())

    def test_eof_error_returns_1_without_traceback(self) -> None:
        with mock.patch("vibeops.cli.build_parser") as build:
            parser = mock.Mock()
            args = mock.Mock()
            args.func = mock.Mock(side_effect=EOFError)
            parser.parse_args.return_value = args
            build.return_value = parser
            err = io.StringIO()
            with redirect_stderr(err):
                code = main(["wizard"])
        self.assertEqual(code, 1)
        self.assertIn("Cancelled", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())


class PromptPasswordTests(unittest.TestCase):
    def test_uses_getpass_and_returns_secret(self) -> None:
        with mock.patch("vibeops.runtime_commands.getpass.getpass", return_value="s3cret") as gp:
            self.assertEqual(prompt_password(), "s3cret")
            gp.assert_called_once()
            prompt = gp.call_args.args[0]
            self.assertIn("password", prompt.lower())
            self.assertTrue(prompt.endswith(": "))

    def test_blank_means_generate(self) -> None:
        with mock.patch("vibeops.runtime_commands.getpass.getpass", return_value=""):
            self.assertIsNone(prompt_password())


class PasswordFlagDiscourageTests(unittest.TestCase):
    def test_help_marks_mysql_password_discouraged(self) -> None:
        parser = build_parser()
        # Find nested app create help via format_help on the leaf parser path.
        help_text = parser.format_help()
        # Full tree help may not include subcommand flags; parse with --help instead.
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            with self.assertRaises(SystemExit):
                parser.parse_args(["app", "create", "--help"])
        text = out.getvalue()
        self.assertIn("--mysql-password", text)
        self.assertIn("discouraged", text.lower())

    def test_help_marks_db_user_reset_password_discouraged(self) -> None:
        parser = build_parser()
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            with self.assertRaises(SystemExit):
                parser.parse_args(["db", "user-reset", "--help"])
        text = out.getvalue()
        self.assertIn("--password", text)
        self.assertIn("discouraged", text.lower())

    def test_cli_flag_present_handles_equals_form(self) -> None:
        self.assertTrue(cli_flag_present("--mysql-password", ["app", "create", "--mysql-password=x"]))
        self.assertTrue(cli_flag_present("--mysql-password", ["--mysql-password", "x"]))
        self.assertFalse(cli_flag_present("--mysql-password", ["app", "create"]))

    def test_warn_password_cli_flag_only_when_on_argv(self) -> None:
        err = io.StringIO()
        with mock.patch("sys.argv", ["manage.py", "user", "create", "shop"]):
            with redirect_stderr(err):
                warn_password_cli_flag("--mysql-password")
        self.assertEqual(err.getvalue(), "")

        err = io.StringIO()
        with mock.patch("sys.argv", ["manage.py", "user", "create", "shop", "--mysql-password", "x"]):
            with redirect_stderr(err):
                warn_password_cli_flag("--mysql-password")
        self.assertIn("shell history", err.getvalue())


class WizardUsesPromptPasswordTests(unittest.TestCase):
    def test_wizard_create_user_calls_prompt_password(self) -> None:
        from vibeops import wizard_commands

        with (
            mock.patch.object(wizard_commands, "prompt_validated", return_value="shop"),
            mock.patch.object(wizard_commands, "prompt_choice", return_value="8.4"),
            mock.patch.object(wizard_commands, "prompt_int", return_value=None),
            mock.patch.object(wizard_commands, "prompt_confirm", side_effect=[True, True, False]),
            mock.patch.object(wizard_commands, "prompt_password", return_value=None) as pp,
            mock.patch.object(wizard_commands, "default_mysql_service", return_value="mysql84"),
            mock.patch.object(wizard_commands, "available_php_versions", return_value=["8.4"]),
            mock.patch.object(wizard_commands, "print_plan"),
            mock.patch.object(wizard_commands, "cmd_user_create") as create,
        ):
            # no_mysql=False path: first confirm True (create mysql), then reload, then cancel continue
            wizard_commands.wizard_create_user()
            # prompt_confirm: Create MySQL? True -> not no_mysql; Reload? True; Continue? False
            pp.assert_called_once()
            create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
