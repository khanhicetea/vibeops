"""Tiny no-dependency template renderer for generated VibeOps config.

Supported syntax intentionally stays small and safe:

- Legacy placeholders: ``__NAME__``
- Variable placeholders: ``${NAME}`` or ``${object.key}``
- Conditionals: ``{% if NAME %}``, ``{% if not NAME %}``, ``{% else %}``, ``{% endif %}``
- Loops: ``{% for ITEM in ITEMS %}``, ``{% endfor %}``

No Python expressions are evaluated. Templates are trusted repo files, but keeping the
language data-only makes generated config easier to review and maintain.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


class TemplateError(ValueError):
    """Raised when a template cannot be parsed or rendered."""


@dataclass(frozen=True)
class TextNode:
    text: str


@dataclass(frozen=True)
class IfNode:
    name: str
    negated: bool
    then_nodes: list[Node]
    else_nodes: list[Node]


@dataclass(frozen=True)
class ForNode:
    var_name: str
    list_name: str
    body: list[Node]


Node = TextNode | IfNode | ForNode

_TAG_RE = re.compile(r"({%\s*.*?\s*%})", re.DOTALL)
_VAR_RE = re.compile(r"\$\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}")
_NAME_RE = r"[A-Za-z_][A-Za-z0-9_.]*"
_IF_RE = re.compile(rf"^if\s+(not\s+)?({_NAME_RE})$")
_FOR_RE = re.compile(rf"^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+({_NAME_RE})$")


def render_template_text(text: str, values: Mapping[str, Any]) -> str:
    """Render a VibeOps template string with a small, safe template language."""
    tokens = _TAG_RE.split(text)
    nodes, index, stop_tag = _parse_block(tokens, 0, frozenset())
    if stop_tag is not None:
        raise TemplateError(f"unexpected template tag: {stop_tag}")
    if index != len(tokens):
        raise TemplateError("template parser stopped before the end of input")
    return _render_nodes(nodes, dict(values))


def _parse_block(tokens: list[str], index: int, stop_tags: frozenset[str]) -> tuple[list[Node], int, str | None]:
    nodes: list[Node] = []
    while index < len(tokens):
        token = tokens[index]
        if token.startswith("{%") and token.endswith("%}"):
            command = token[2:-2].strip()
            command_name = command.split(None, 1)[0] if command else ""
            if command_name in stop_tags:
                return nodes, index + 1, command_name

            if_match = _IF_RE.match(command)
            if if_match:
                then_nodes, index, stop_tag = _parse_block(tokens, index + 1, frozenset({"else", "endif"}))
                else_nodes: list[Node] = []
                if stop_tag == "else":
                    else_nodes, index, stop_tag = _parse_block(tokens, index, frozenset({"endif"}))
                if stop_tag != "endif":
                    raise TemplateError("missing {% endif %}")
                nodes.append(IfNode(name=if_match.group(2), negated=bool(if_match.group(1)), then_nodes=then_nodes, else_nodes=else_nodes))
                continue

            for_match = _FOR_RE.match(command)
            if for_match:
                body, index, stop_tag = _parse_block(tokens, index + 1, frozenset({"endfor"}))
                if stop_tag != "endfor":
                    raise TemplateError("missing {% endfor %}")
                nodes.append(ForNode(var_name=for_match.group(1), list_name=for_match.group(2), body=body))
                continue

            if command_name in {"else", "endif", "endfor"}:
                raise TemplateError(f"unexpected template tag: {command_name}")
            raise TemplateError(f"unknown template tag: {command}")

        nodes.append(TextNode(token))
        index += 1
    return nodes, index, None


def _render_nodes(nodes: list[Node], context: dict[str, Any]) -> str:
    parts: list[str] = []
    for node in nodes:
        if isinstance(node, TextNode):
            parts.append(_render_text(node.text, context))
        elif isinstance(node, IfNode):
            value = bool(_lookup(context, node.name))
            if node.negated:
                value = not value
            parts.append(_render_nodes(node.then_nodes if value else node.else_nodes, context))
        elif isinstance(node, ForNode):
            iterable = _lookup(context, node.list_name)
            if iterable is None:
                continue
            if isinstance(iterable, (str, bytes)):
                raise TemplateError(f"loop value is not a list: {node.list_name}")
            try:
                iterator = iter(iterable)
            except TypeError as exc:
                raise TemplateError(f"loop value is not iterable: {node.list_name}") from exc
            previous = context.get(node.var_name, None)
            had_previous = node.var_name in context
            for item in iterator:
                context[node.var_name] = item
                parts.append(_render_nodes(node.body, context))
            if had_previous:
                context[node.var_name] = previous
            else:
                context.pop(node.var_name, None)
    return "".join(parts)


def _render_text(text: str, context: Mapping[str, Any]) -> str:
    # Backwards-compatible replacement for existing ``__NAME__`` templates.
    for key in sorted(context, key=len, reverse=True):
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            text = text.replace(f"__{key}__", str(context[key]))

    def replace_var(match: re.Match[str]) -> str:
        return str(_lookup(context, match.group(1)))

    return _VAR_RE.sub(replace_var, text)


def _lookup(context: Mapping[str, Any], name: str) -> Any:
    value: Any = context
    for part in name.split("."):
        if isinstance(value, Mapping):
            if part not in value:
                raise TemplateError(f"missing template value: {name}")
            value = value[part]
        else:
            try:
                value = getattr(value, part)
            except AttributeError as exc:
                raise TemplateError(f"missing template value: {name}") from exc
    return value
