"""Subprocess helpers and Docker service discovery."""

from __future__ import annotations

import gzip
import shutil
import subprocess
from pathlib import Path

from bento.utils.errors import StackError
from bento.utils.paths import ROOT

def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def run(cmd: list[str], *, input_text: str | None = None, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(ROOT),
        input=input_text,
        text=True,
        check=check,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


# Bound captured process diagnostics so huge stderr cannot pin memory.
_MAX_CAPTURED_DIAGNOSTIC_BYTES = 64 * 1024


def _bounded_bytes(data: bytes | None, limit: int = _MAX_CAPTURED_DIAGNOSTIC_BYTES) -> bytes:
    if not data:
        return b""
    if len(data) <= limit:
        return data
    return data[:limit] + b"\n...[truncated]..."


def run_stdin_stream(
    cmd: list[str],
    *,
    stdin_file,
    check: bool = True,
    capture_stdout: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    """Run *cmd* with an open binary file as stdin (no full-buffer ``input=``).

    Stdout/stderr are captured with a bound on how much is retained for diagnostics.
    The caller owns *stdin_file* lifetime.
    """
    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdin=stdin_file,
        stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        stdout, stderr = proc.communicate()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
    stdout_b = _bounded_bytes(stdout)
    stderr_b = _bounded_bytes(stderr)
    completed = subprocess.CompletedProcess(cmd, proc.returncode or 0, stdout_b, stderr_b)
    if check and completed.returncode != 0:
        err = (stderr_b or stdout_b).decode("utf-8", errors="replace").strip()
        raise StackError(
            f"command failed (exit {completed.returncode}): {' '.join(cmd)}"
            + (f": {err}" if err else "")
        )
    return completed


def run_stdout_to_file(
    cmd: list[str],
    *,
    stdout_file,
    check: bool = True,
    gzip_compress: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    """Run *cmd* streaming stdout into an open binary file; capture bounded stderr.

    When *gzip_compress* is true, stdout is piped through stdlib gzip into
    *stdout_file* (still streaming; not buffered as a full dump). The returned
    process has ``raw_bytes`` set to the uncompressed byte count written.
    """
    if not gzip_compress:
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=stdout_file,
            stderr=subprocess.PIPE,
        )
        try:
            _, stderr = proc.communicate()
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()
        stderr_b = _bounded_bytes(stderr)
        completed = subprocess.CompletedProcess(cmd, proc.returncode or 0, b"", stderr_b)
        if check and completed.returncode != 0:
            err = stderr_b.decode("utf-8", errors="replace").strip()
            raise StackError(
                f"command failed (exit {completed.returncode}): {' '.join(cmd)}"
                + (f": {err}" if err else "")
            )
        return completed

    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    raw_bytes = 0
    stderr = b""
    rc = 1
    try:
        assert proc.stdout is not None
        # Do not close stdout_file when the GzipFile closes.
        with gzip.GzipFile(fileobj=stdout_file, mode="wb", mtime=0, compresslevel=6) as gz:
            while True:
                chunk = proc.stdout.read(256 * 1024)
                if not chunk:
                    break
                raw_bytes += len(chunk)
                gz.write(chunk)
        stderr = proc.stderr.read() if proc.stderr else b""
        rc = proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
    stderr_b = _bounded_bytes(stderr)
    completed = subprocess.CompletedProcess(cmd, rc if rc is not None else (proc.returncode or 0), b"", stderr_b)
    # Uncompressed dump size for empty-output checks (gzip files are never 0-byte when valid).
    setattr(completed, "raw_bytes", raw_bytes)
    if check and completed.returncode != 0:
        err = stderr_b.decode("utf-8", errors="replace").strip()
        raise StackError(
            f"command failed (exit {completed.returncode}): {' '.join(cmd)}"
            + (f": {err}" if err else "")
        )
    return completed


def docker_available() -> bool:
    return command_exists("docker")


def running_services() -> set[str]:
    if not docker_available():
        return set()
    cp = run(
        ["docker", "compose", "ps", "--services", "--filter", "status=running"],
        check=False,
        capture=True,
    )
    if cp.returncode != 0:
        return set()
    return {line.strip() for line in cp.stdout.splitlines() if line.strip()}


def service_running(service: str) -> bool:
    return service in running_services()
