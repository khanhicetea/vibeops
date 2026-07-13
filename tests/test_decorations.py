"""Dependency-free wizard presentation helpers."""
from __future__ import annotations

import unittest

from bento.ui.decorations import (
    format_alert,
    format_bottom_border,
    format_heading,
    format_list,
    format_menu,
    left_pad,
)


class DecorationTests(unittest.TestCase):
    def test_left_pad_indents_every_line(self) -> None:
        self.assertEqual(left_pad("one\ntwo", 3), "   one\n   two")

    def test_heading_is_ascii(self) -> None:
        self.assertEqual(format_heading("Apps"), ["=== Apps ==="])

    def test_list_aligns_continuation_lines(self) -> None:
        self.assertEqual(format_list(["one\ntwo"]), ["  - one", "    two"])

    def test_menu_preserves_numbered_format(self) -> None:
        self.assertEqual(format_menu("Action", [(0, "Back"), (1, "Create")], width=16), [
            "Action:",
            "  0 - Back",
            "  1 - Create",
            "----------------",
        ])

    def test_menu_can_mark_selected_entry(self) -> None:
        lines = format_menu("Action", [(0, "Back"), (1, "Create")], selected_number=1, width=16)
        self.assertEqual(lines[1], "    0 - Back")
        self.assertEqual(lines[2], "  > 1 - Create")

    def test_bottom_border_honors_width_and_indent(self) -> None:
        self.assertEqual(format_bottom_border(width=12, indent=2), "  ----------")
        self.assertEqual(format_bottom_border(width=80), "-" * 70)

    def test_alert_marks_severity_and_aligns_lines(self) -> None:
        self.assertEqual(format_alert("first\nsecond", kind="warning"), ["[!] first", "    second"])

    def test_alert_rejects_unknown_kind(self) -> None:
        with self.assertRaises(ValueError):
            format_alert("bad", kind="mystery")


if __name__ == "__main__":
    unittest.main()
