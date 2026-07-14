.PHONY: check test syntax

# One-command verification gate for local and CI.
check: syntax test

syntax:
	@python3 -B -c 'import ast, pathlib, sys; \
paths=[p for p in pathlib.Path(".").rglob("*.py") if ".git" not in p.parts and "__pycache__" not in p.parts and "runtime" not in p.parts]; \
[ast.parse(p.read_text(), filename=str(p)) for p in paths]; \
print(f"syntax ok ({len(paths)} files)")'
	@sh -n docker/php/bin/* 2>/dev/null || true
	@bash -n docker/mysql/5.7/docker-entrypoint.sh

test:
	PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -v
