"""Terminal-width-aware table formatting."""
from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from bento.ui.table import format_ascii_table, format_table, print_table, terminal_width, truncate_cell


class TerminalWidthTests(unittest.TestCase):
    def test_uses_shutil_get_terminal_size(self) -> None:
        with mock.patch("bento.ui.table.shutil.get_terminal_size") as gts:
            gts.return_value = mock.Mock(columns=120, lines=40)
            self.assertEqual(terminal_width(), 120)
            gts.assert_called_once()
            # fallback tuple is provided for non-TTY environments
            self.assertEqual(gts.call_args.kwargs.get("fallback") or gts.call_args.args[0], (80, 24))

    def test_clamps_very_narrow(self) -> None:
        with mock.patch("bento.ui.table.shutil.get_terminal_size") as gts:
            gts.return_value = mock.Mock(columns=10, lines=20)
            self.assertGreaterEqual(terminal_width(), 40)


class TruncateCellTests(unittest.TestCase):
    def test_short_unchanged(self) -> None:
        self.assertEqual(truncate_cell("abc", 5), "abc")

    def test_truncates_with_ellipsis(self) -> None:
        self.assertEqual(truncate_cell("abcdef", 4), "abc…")

    def test_width_one(self) -> None:
        self.assertEqual(truncate_cell("ab", 1), "…")


class FormatTableTests(unittest.TestCase):
    def test_aligns_columns_with_header(self) -> None:
        lines = format_table(
            [["shop", "8.4", "shop.example.com"], ["blog", "8.5", "blog.test"]],
            headers=["APP", "PHP", "MAIN"],
            width=80,
        )
        self.assertEqual(lines[0].split(), ["APP", "PHP", "MAIN"])
        self.assertTrue(set(lines[1].replace(" ", "")) <= {"-"})
        self.assertIn("shop", lines[2])
        self.assertIn("8.4", lines[2])
        # Columns should be padded so PHP values align across rows.
        shop_php = lines[2].index("8.4")
        blog_php = lines[3].index("8.5")
        self.assertEqual(shop_php, blog_php)

    def test_fits_narrow_terminal_by_truncating(self) -> None:
        long_domain = "very-long-subdomain.example-company.example.com"
        lines = format_table(
            [["shop", long_domain]],
            headers=["APP", "MAIN"],
            width=40,
        )
        for line in lines:
            self.assertLessEqual(len(line), 40)
        self.assertTrue(any("…" in line for line in lines[2:]))

    def test_empty_rows_headers_only(self) -> None:
        lines = format_table([], headers=["A", "B"], width=40)
        self.assertEqual(len(lines), 2)
        self.assertIn("A", lines[0])

    def test_no_headers(self) -> None:
        lines = format_table([["a", "b"]], headers=None, width=40)
        self.assertEqual(len(lines), 1)
        self.assertIn("a", lines[0])

    def test_print_table_uses_info_and_prefix(self) -> None:
        out = io.StringIO()
        with mock.patch("bento.ui.table.terminal_width", return_value=80):
            with redirect_stdout(out):
                print_table([["x", "y"]], headers=["H1", "H2"], prefix="  ")
        text = out.getvalue()
        self.assertTrue(text.startswith("  "))
        self.assertIn("H1", text)
        self.assertIn("x", text)

    def test_strips_control_chars_from_cells(self) -> None:
        lines = format_table([["a\tb", "c\nd"]], headers=["X", "Y"], width=40)
        body = lines[2]
        self.assertNotIn("\t", body)
        self.assertNotIn("\n", body)

    def test_ascii_table_has_borders_and_fits_width(self) -> None:
        lines = format_ascii_table(
            [["shop", "very-long-subdomain.example-company.example.com"]],
            headers=["APP", "DOMAIN"],
            width=40,
        )
        self.assertTrue(lines[0].startswith("+"))
        self.assertTrue(lines[1].startswith("| APP"))
        self.assertEqual(lines[0], lines[2])
        self.assertEqual(lines[0], lines[-1])
        self.assertTrue(any("…" in line for line in lines))
        self.assertTrue(all(len(line) <= 40 for line in lines))


if __name__ == "__main__":
    unittest.main()
