"""Tests for staged/validated/rollback-safe render and apply."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vibeops.helpers as helpers
import vibeops.runtime_commands as runtime


def _snapshot_tree(root: Path) -> dict[str, tuple[bytes, int]]:
    out: dict[str, tuple[bytes, int]] = {}
    if not root.exists():
        return out
    for path in sorted(root.rglob("*")):
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            out[rel] = (path.read_bytes(), path.stat().st_mode & 0o777)
    return out


def _write_live_marker(path: Path, content: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(mode)


class RenderTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runtime_dir = self.root / "runtime"
        self.generated = self.runtime_dir / "generated"
        self.secrets = self.runtime_dir / "secrets" / "mysql"
        self.generated.mkdir(parents=True)
        self.secrets.mkdir(parents=True)
        self.live = helpers.RenderContext(generated_dir=self.generated, secrets_dir=self.secrets)
        # Isolate app homes and avoid repo runtime side effects.
        self.home = self.runtime_dir / "home"
        self.home.mkdir()
        self.patches = [
            patch.object(helpers, "HOME_DIR", self.home),
            patch.object(helpers, "PHP_SOCKET_DIR", self.runtime_dir / "run" / "php-fpm"),
            patch.object(helpers, "PHP_LOG_DIR", self.runtime_dir / "logs" / "php"),
            patch.object(helpers, "RUNTIME_DIR", self.runtime_dir),
            patch.object(helpers, "GENERATED_DIR", self.generated),
            patch.object(helpers, "MYSQL_SECRETS_DIR", self.secrets),
            patch.object(helpers, "PHP_VERSIONS_DIR", self.generated / "php" / "versions"),
            patch.object(helpers, "CRON_RUNTIME_DIR", self.generated / "cron"),
            patch.object(helpers, "NGINX_VHOST_DIR", self.generated / "nginx" / "vhosts"),
            patch.object(runtime, "RUNTIME_DIR", self.runtime_dir),
            patch.object(runtime, "available_php_versions", return_value=["8.4"]),
            patch.object(helpers, "stack_env", return_value={"DEFAULT_PHP_VERSION": "8.4", "SOCKET_GROUP_NAME": "nginxsock"}),
            patch.object(helpers, "docker_available", return_value=False),
            patch.object(helpers, "service_running", return_value=False),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def _empty_db(self) -> dict:
        return helpers.empty_db()

    def _app_db(self, name: str = "shop", domain: str = "shop.test") -> dict:
        db = self._empty_db()
        db["apps"][name] = {
            "name": name,
            "uid": 10001,
            "php_version": "8.4",
            "main_domain": domain,
            "domains": [domain],
            "public_dir": "",
            "php_entrypoint": "legacy",
            "tls": {"mode": "self-signed"},
        }
        db["domains"][domain] = {"kind": "php", "app": name}
        return db

    def test_empty_render_does_not_touch_repo_generated(self) -> None:
        repo_generated = Path(helpers.ROOT) / "runtime" / "generated"
        repo_secrets = Path(helpers.ROOT) / "runtime" / "secrets"
        before_gen = _snapshot_tree(repo_generated) if repo_generated.exists() else {}
        before_sec = _snapshot_tree(repo_secrets) if repo_secrets.exists() else {}

        paths = runtime.apply_generated_config(
            self._empty_db(),
            live=self.live,
            runtime_dir=self.runtime_dir,
        )
        self.assertTrue(paths)
        # Fallback pool for available PHP version always rendered.
        self.assertTrue((self.generated / "php" / "versions" / "8.4" / "pool.d" / "zz-fallback.conf").is_file())
        self.assertTrue((self.generated / "cron" / "php84" / ".supercronic.cron").is_file())

        after_gen = _snapshot_tree(repo_generated) if repo_generated.exists() else {}
        after_sec = _snapshot_tree(repo_secrets) if repo_secrets.exists() else {}
        self.assertEqual(before_gen, after_gen)
        self.assertEqual(before_sec, after_sec)
        # No leftover transaction dirs after success.
        self.assertEqual(list(self.runtime_dir.glob(f"{helpers.RENDER_TXN_DIR_PREFIX}*")), [])

    def test_multi_app_render_writes_identities_and_vhosts(self) -> None:
        db = self._app_db("shop", "shop.test")
        db["apps"]["blog"] = {
            "name": "blog",
            "uid": 10002,
            "php_version": "8.4",
            "main_domain": "blog.test",
            "domains": ["blog.test"],
            "public_dir": "public",
            "php_entrypoint": "front-controller",
            "tls": {"mode": "self-signed"},
        }
        db["domains"]["blog.test"] = {"kind": "php", "app": "blog"}
        paths = runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        self.assertGreaterEqual(len(paths), 4)
        shop_vhost = self.generated / "nginx" / "vhosts" / "app-shop.conf"
        blog_vhost = self.generated / "nginx" / "vhosts" / "app-blog.conf"
        self.assertTrue(shop_vhost.is_file())
        self.assertTrue(blog_vhost.is_file())
        self.assertIn(helpers.GENERATED_NOTICE, shop_vhost.read_text())
        self.assertIn("shop.test", shop_vhost.read_text())
        self.assertIn("blog.test", blog_vhost.read_text())
        env = (self.generated / "php" / "versions" / "8.4" / "users.d" / "shop.env").read_text()
        self.assertIn("UID=10001", env)
        self.assertIn(helpers.GENERATED_NOTICE, env)

    def test_generation_failure_before_promotion_leaves_live_unchanged(self) -> None:
        # Seed live content.
        marker = self.generated / "nginx" / "vhosts" / "app-old.conf"
        _write_live_marker(marker, f"# {helpers.GENERATED_NOTICE}\nold-content\n", 0o644)
        before = _snapshot_tree(self.generated)

        def boom() -> None:
            raise helpers.StackError("injected stage failure")

        with self.assertRaisesRegex(helpers.StackError, "injected stage failure"):
            runtime.apply_generated_config(
                self._app_db(),
                live=self.live,
                runtime_dir=self.runtime_dir,
                fault_during_stage=boom,
            )
        self.assertEqual(before, _snapshot_tree(self.generated))
        self.assertEqual(list(self.runtime_dir.glob(f"{helpers.RENDER_TXN_DIR_PREFIX}*")), [])

    def test_promotion_fault_rolls_back_full_tree(self) -> None:
        db = self._app_db()
        # Establish a known good generation first.
        runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        before = _snapshot_tree(self.generated)
        before_modes = {k: v[1] for k, v in before.items()}

        # Change state so a second render would rewrite files, then fault mid-promote.
        db["apps"]["shop"]["domains"] = ["shop.test", "alias.shop.test"]
        db["domains"]["alias.shop.test"] = {"kind": "php", "app": "shop"}
        with self.assertRaisesRegex(helpers.StackError, "Injected promotion fault"):
            runtime.apply_generated_config(
                db,
                live=self.live,
                runtime_dir=self.runtime_dir,
                fault_after_promotions=1,
            )
        after = _snapshot_tree(self.generated)
        self.assertEqual(before, after)
        self.assertEqual(before_modes, {k: v[1] for k, v in after.items()})

    def test_stale_generated_removed_only_after_success(self) -> None:
        stale = self.generated / "nginx" / "vhosts" / "app-gone.conf"
        _write_live_marker(stale, f"# {helpers.GENERATED_NOTICE}\nstale\n")
        unmanaged = self.generated / "nginx" / "vhosts" / "custom-local.conf"
        _write_live_marker(unmanaged, "# hand-written local override\nserver {}\n")

        runtime.apply_generated_config(self._app_db(), live=self.live, runtime_dir=self.runtime_dir)
        self.assertFalse(stale.exists())
        self.assertTrue(unmanaged.exists())
        self.assertEqual(unmanaged.read_text(), "# hand-written local override\nserver {}\n")

    def test_secret_mode_preserved(self) -> None:
        with patch.object(
            helpers,
            "stack_env",
            return_value={
                "DEFAULT_PHP_VERSION": "8.4",
                "SOCKET_GROUP_NAME": "nginxsock",
                "MYSQL84_ROOT_PASSWORD": "s3cret",
            },
        ):
            runtime.apply_generated_config(self._empty_db(), live=self.live, runtime_dir=self.runtime_dir)
        secret = self.secrets / "mysql84-root.cnf"
        self.assertTrue(secret.is_file())
        self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
        # Must not log/print password content in normal path (file only).
        self.assertIn('password="s3cret"', secret.read_text())

    def test_validation_failure_rolls_back(self) -> None:
        db = self._app_db()
        runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        before = _snapshot_tree(self.generated)
        db["apps"]["shop"]["domains"] = ["shop.test", "new.shop.test"]
        db["domains"]["new.shop.test"] = {"kind": "php", "app": "shop"}

        with patch.object(runtime, "validate_generated_services", side_effect=helpers.StackError("nginx -t failed")):
            with self.assertRaisesRegex(helpers.StackError, "nginx -t failed"):
                runtime.apply_generated_config(
                    db,
                    live=self.live,
                    runtime_dir=self.runtime_dir,
                    validate_services=True,
                )
        self.assertEqual(before, _snapshot_tree(self.generated))

    def test_no_reload_until_all_validators_pass(self) -> None:
        db = self._app_db()
        order: list[str] = []

        def validate(_db: dict) -> None:
            order.append("validate")

        def reload(_db: dict) -> None:
            order.append("reload")

        with patch.object(runtime, "validate_generated_services", side_effect=validate), patch.object(
            runtime, "reload_generated_services", side_effect=reload
        ):
            runtime.apply_generated_config(
                db,
                live=self.live,
                runtime_dir=self.runtime_dir,
                validate_services=True,
                reload_services=True,
            )
        self.assertEqual(order, ["validate", "reload"])

        order.clear()

        def fail_validate(_db: dict) -> None:
            order.append("validate")
            raise helpers.StackError("bad config")

        with patch.object(runtime, "validate_generated_services", side_effect=fail_validate), patch.object(
            runtime, "reload_generated_services", side_effect=reload
        ):
            with self.assertRaises(helpers.StackError):
                runtime.apply_generated_config(
                    db,
                    live=self.live,
                    runtime_dir=self.runtime_dir,
                    validate_services=True,
                    reload_services=True,
                )
        self.assertEqual(order, ["validate"])

    def test_abandoned_transaction_mid_promotion_is_restored(self) -> None:
        db = self._app_db()
        runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        vhost = self.generated / "nginx" / "vhosts" / "app-shop.conf"
        original = vhost.read_text()
        before = _snapshot_tree(self.generated)

        txn = self.runtime_dir / f"{helpers.RENDER_TXN_DIR_PREFIX}deadbeef"
        backup = txn / "backup"
        backup_file = backup / "generated" / "nginx" / "vhosts" / "app-shop.conf"
        backup_file.parent.mkdir(parents=True)
        backup_file.write_text(original)
        # Corrupt live as if promotion partially applied.
        vhost.write_text("CORRUPTED")
        journal = {
            "version": helpers.RENDER_TXN_JOURNAL_VERSION,
            "status": "promoting",
            "txn_id": "deadbeef",
            "promotions": [
                {
                    "root": "generated",
                    "rel": "nginx/vhosts/app-shop.conf",
                    "mode": 0o644,
                    "existed": True,
                    "created": False,
                    "backup": "generated/nginx/vhosts/app-shop.conf",
                    "previous_mode": 0o644,
                }
            ],
            "removals": [],
            "manifest": [],
        }
        (txn / "journal.json").write_text(json.dumps(journal))

        runtime.recover_abandoned_transactions(self.runtime_dir, self.live)
        self.assertEqual(vhost.read_text(), original)
        self.assertFalse(txn.exists())
        # Full tree should match pre-corruption content for restored path.
        self.assertEqual(before[vhost.relative_to(self.generated).as_posix()][0], vhost.read_bytes())

    def test_tls_state_render_failure_keeps_previous_generation(self) -> None:
        db = self._app_db()
        runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        vhost = self.generated / "nginx" / "vhosts" / "app-shop.conf"
        before_text = vhost.read_text()
        before_tree = _snapshot_tree(self.generated)

        db["apps"]["shop"]["tls"] = {"mode": "acme", "redirect_https": True}

        def boom() -> None:
            raise helpers.StackError("template boom")

        with self.assertRaisesRegex(helpers.StackError, "template boom"):
            runtime.apply_generated_config(
                db,
                live=self.live,
                runtime_dir=self.runtime_dir,
                fault_during_stage=boom,
            )
        self.assertEqual(before_tree, _snapshot_tree(self.generated))
        self.assertEqual(vhost.read_text(), before_text)

    def test_fault_on_final_promotion_rolls_back(self) -> None:
        db = self._app_db()
        runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        before = _snapshot_tree(self.generated)
        # Count how many files a second identical render would promote.
        staging_count = {"n": 0}

        real_promote = runtime.promote_manifest

        def counting_promote(manifest, *args, **kwargs):
            staging_count["n"] = len(manifest)
            # Fail on the last promotion.
            kwargs = dict(kwargs)
            kwargs["fault_after_promotions"] = max(0, len(manifest) - 1)
            return real_promote(manifest, *args, **kwargs)

        db["apps"]["shop"]["public_dir"] = "public"
        with patch.object(runtime, "promote_manifest", side_effect=counting_promote):
            with self.assertRaisesRegex(helpers.StackError, "Injected promotion fault"):
                runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        self.assertEqual(before, _snapshot_tree(self.generated))
        self.assertGreater(staging_count["n"], 1)


class ApplyValidationOrderTests(unittest.TestCase):
    def test_validate_calls_nginx_php_cron_in_order(self) -> None:
        calls: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            return None

        db = helpers.empty_db()
        db["apps"]["shop"] = {"name": "shop", "php_version": "8.4"}
        db["crons"]["shop/job"] = {"php_version": "8.4"}

        with patch.object(runtime, "docker_available", return_value=True), patch.object(
            runtime, "service_running", return_value=True
        ), patch.object(runtime, "run", side_effect=fake_run), patch.object(
            runtime, "available_php_versions", return_value=["8.4"]
        ):
            runtime.validate_generated_services(db)

        joined = [" ".join(c) for c in calls]
        self.assertTrue(any("nginx -t" in j for j in joined))
        self.assertTrue(any("php-fpm -tt" in j for j in joined))
        self.assertTrue(any("supercronic -test" in j for j in joined))
        nginx_i = next(i for i, j in enumerate(joined) if "nginx -t" in j)
        fpm_i = next(i for i, j in enumerate(joined) if "php-fpm -tt" in j)
        cron_i = next(i for i, j in enumerate(joined) if "supercronic -test" in j)
        self.assertLess(nginx_i, fpm_i)
        self.assertLess(fpm_i, cron_i)


if __name__ == "__main__":
    unittest.main()
