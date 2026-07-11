"""CLI UX: interactive cancellation and secret input handling."""
from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr
from unittest import mock

from vibeops.commands.cli import main
from vibeops.utils.errors import cli_flag_present, warn_password_cli_flag
from vibeops.commands.parser import build_parser
from vibeops.commands.runtime_commands import prompt_password


class CliCancellationTests(unittest.TestCase):
    def test_keyboard_interrupt_returns_130_without_traceback(self) -> None:
        with mock.patch("vibeops.commands.cli.build_parser") as build:
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
        with mock.patch("vibeops.commands.cli.build_parser") as build:
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
        with mock.patch("vibeops.commands.runtime_commands.getpass.getpass", return_value="s3cret") as gp:
            self.assertEqual(prompt_password(), "s3cret")
            gp.assert_called_once()
            prompt = gp.call_args.args[0]
            self.assertIn("password", prompt.lower())
            self.assertTrue(prompt.endswith(": "))

    def test_blank_means_generate(self) -> None:
        with mock.patch("vibeops.commands.runtime_commands.getpass.getpass", return_value=""):
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
        from vibeops.commands import wizard_commands

        with (
            mock.patch.object(wizard_commands, "prompt_validated", return_value="shop"),
            mock.patch.object(wizard_commands, "prompt_pick", return_value="8.4"),
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


def _force_numbered_choice():
    """Context that forces the non-TTY number prompt path (for unit tests)."""
    return mock.patch("sys.stdin.isatty", return_value=False)


class PromptChoiceZeroTests(unittest.TestCase):
    def test_shows_zero_back_and_accepts_zero(self) -> None:
        from vibeops.commands.runtime_commands import prompt_choice

        out = io.StringIO()
        with (
            _force_numbered_choice(),
            mock.patch("builtins.input", return_value="0") as inp,
            mock.patch("sys.stdout", out),
        ):
            result = prompt_choice("Action", ["One", "Two"])
        self.assertEqual(result, "Back")
        text = out.getvalue()
        self.assertIn("0 - Back", text)
        self.assertIn("1 - One", text)
        self.assertIn("2 - Two", text)
        self.assertIn("Choose 0-2", inp.call_args.args[0])

    def test_main_menu_zero_quit(self) -> None:
        from vibeops.commands.runtime_commands import prompt_choice

        out = io.StringIO()
        with (
            _force_numbered_choice(),
            mock.patch("builtins.input", return_value="0"),
            mock.patch("sys.stdout", out),
        ):
            result = prompt_choice("What do you want to do?", ["Create app"], zero="Quit")
        self.assertEqual(result, "Quit")
        self.assertIn("0 - Quit", out.getvalue())

    def test_selects_numbered_choice(self) -> None:
        from vibeops.commands.runtime_commands import prompt_choice

        with (
            _force_numbered_choice(),
            mock.patch("builtins.input", return_value="2"),
            mock.patch("sys.stdout", io.StringIO()),
        ):
            self.assertEqual(prompt_choice("Pick", ["A", "B", "C"]), "B")

    def test_prompt_pick_raises_wizard_back_on_zero(self) -> None:
        from vibeops.commands.runtime_commands import WizardBack, prompt_pick

        with (
            _force_numbered_choice(),
            mock.patch("builtins.input", return_value="0"),
            mock.patch("sys.stdout", io.StringIO()),
        ):
            with self.assertRaises(WizardBack):
                prompt_pick("PHP version", ["8.4", "8.5"])


class PromptChoiceArrowTests(unittest.TestCase):
    def _run_interactive(
        self,
        keys: list[str],
        choices: list[str],
        *,
        label: str = "Pick",
        default: str | None = None,
        zero: str | None = "Back",
    ):
        from vibeops.commands import runtime_commands

        key_iter = iter(keys)

        def fake_read_key() -> str:
            try:
                return next(key_iter)
            except StopIteration as exc:
                raise EOFError from exc

        out = io.StringIO()
        with (
            mock.patch.object(runtime_commands, "_read_menu_key", side_effect=fake_read_key),
            mock.patch("termios.tcgetattr", return_value=object()),
            mock.patch("termios.tcsetattr"),
            mock.patch("tty.setcbreak"),
            mock.patch.object(runtime_commands.sys, "stdout", out),
            mock.patch.object(runtime_commands.sys.stdin, "fileno", return_value=0),
        ):
            result = runtime_commands._prompt_choice_interactive(label, choices, default, zero)
        return result, out.getvalue()

    def test_enter_selects_highlighted_default(self) -> None:
        result, text = self._run_interactive(["enter"], ["A", "B", "C"], default="B")
        self.assertEqual(result, "B")
        self.assertIn("↑↓", text)
        self.assertIn("> 2 - B", text)

    def test_down_then_enter_moves_selection(self) -> None:
        # zero=Back at index 0; default none starts on first real option (A).
        result, _text = self._run_interactive(["down", "enter"], ["A", "B"])
        self.assertEqual(result, "B")

    def test_up_wraps_to_last(self) -> None:
        result, _text = self._run_interactive(["up", "enter"], ["A", "B"], zero=None)
        self.assertEqual(result, "B")

    def test_digit_instant_select(self) -> None:
        result, _text = self._run_interactive(["2"], ["A", "B", "C"])
        self.assertEqual(result, "B")

    def test_digit_zero_selects_back(self) -> None:
        result, _text = self._run_interactive(["0"], ["A", "B"])
        self.assertEqual(result, "Back")

    def test_multi_digit_buffer_and_enter(self) -> None:
        # 10+ choices disables instant digit select; type "10" + enter.
        choices = [f"item{i}" for i in range(1, 12)]
        result, text = self._run_interactive(["1", "0", "enter"], choices, zero=None)
        self.assertEqual(result, "item10")
        self.assertIn("number: 10", text)

    def test_prompt_choice_uses_arrows_when_tty(self) -> None:
        from vibeops.commands import runtime_commands

        with (
            mock.patch.object(runtime_commands.sys.stdin, "isatty", return_value=True),
            mock.patch.object(runtime_commands.sys.stdout, "isatty", return_value=True),
            mock.patch.object(runtime_commands.sys.stdin, "fileno", return_value=0),
            mock.patch.object(
                runtime_commands,
                "_prompt_choice_interactive",
                return_value="from-arrows",
            ) as interactive,
            mock.patch.object(
                runtime_commands,
                "_prompt_choice_numbered",
                return_value="from-numbers",
            ) as numbered,
        ):
            result = runtime_commands.prompt_choice("Pick", ["A", "B"])
        self.assertEqual(result, "from-arrows")
        interactive.assert_called_once()
        numbered.assert_not_called()

    def test_prompt_choice_uses_numbers_when_not_tty(self) -> None:
        from vibeops.commands import runtime_commands

        with (
            mock.patch.object(runtime_commands.sys.stdin, "isatty", return_value=False),
            mock.patch.object(
                runtime_commands,
                "_prompt_choice_numbered",
                return_value="from-numbers",
            ) as numbered,
            mock.patch.object(
                runtime_commands,
                "_prompt_choice_interactive",
                return_value="from-arrows",
            ) as interactive,
        ):
            result = runtime_commands.prompt_choice("Pick", ["A", "B"])
        self.assertEqual(result, "from-numbers")
        numbered.assert_called_once()
        interactive.assert_not_called()

    def test_left_right_arrows_do_not_freeze(self) -> None:
        """Left/right CSI finals (C/D) must not block waiting for more input."""
        from vibeops.commands import runtime_commands

        # Sequence: left (ESC[D), right (ESC[C), down, enter → select B
        # (zero=Back at 0; start on A; down → B)
        bytes_in = iter("\x1b[D\x1b[C\x1b[B\r")

        def fake_read(n: int = 1) -> str:
            try:
                return "".join(next(bytes_in) for _ in range(n))
            except StopIteration as exc:
                raise AssertionError("read blocked past available key bytes (would freeze)") from exc

        out = io.StringIO()
        with (
            mock.patch.object(runtime_commands.sys.stdin, "read", side_effect=fake_read),
            mock.patch("termios.tcgetattr", return_value=object()),
            mock.patch("termios.tcsetattr"),
            mock.patch("tty.setcbreak"),
            mock.patch.object(runtime_commands.sys, "stdout", out),
            mock.patch.object(runtime_commands.sys.stdin, "fileno", return_value=0),
        ):
            result = runtime_commands._prompt_choice_interactive("Pick", ["A", "B"], None, "Back")
        self.assertEqual(result, "B")


if __name__ == "__main__":
    unittest.main()
