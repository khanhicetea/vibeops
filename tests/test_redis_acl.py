import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vibeops.services import redis
from vibeops.utils.env import parse_env_file


class RedisAclTests(unittest.TestCase):
    def test_credentials_are_stable_and_prefixed(self) -> None:
        with tempfile.TemporaryDirectory() as td, \
             patch.object(redis, "HOME_DIR", Path(td)), \
             patch.object(redis, "stack_env", return_value={"REDIS_APP_ACL": "true"}), \
             patch.object(redis, "service_running", return_value=False):
            created, rel_path = redis.ensure_redis_user("shop")
            self.assertFalse(created)
            path = Path(td) / "shop" / ".credentials" / "redis.env"
            first = parse_env_file(path)
            redis.ensure_redis_user("shop")
            second = parse_env_file(path)
            self.assertEqual(first["REDIS_PASSWORD"], second["REDIS_PASSWORD"])
            self.assertEqual(first["REDIS_USERNAME"], "shop")
            self.assertEqual(first["REDIS_DB"], "0")
            self.assertEqual(first["REDIS_PREFIX"], "shop:")
            self.assertTrue(rel_path.endswith("shop/.credentials/redis.env"))

    def test_acl_secret_is_sent_on_stdin_not_argv(self) -> None:
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            captured["stdin"] = kwargs["input_text"]
            return type("Result", (), {"returncode": 0, "stdout": "errors: 0", "stderr": ""})()

        with patch.object(redis, "stack_env", return_value={"REDIS_ADMIN_PASSWORD": "admin-secret"}), \
             patch.object(redis, "run", side_effect=fake_run):
            redis.redis_acl_exec("ACL", "SETUSER", "shop", ">app-secret")
        self.assertNotIn("admin-secret", " ".join(captured["argv"]))
        self.assertNotIn("app-secret", " ".join(captured["argv"]))
        self.assertIn("admin-secret", captured["stdin"])
        self.assertIn("app-secret", captured["stdin"])

    def test_shared_mode_uses_stack_password_and_empty_username(self) -> None:
        with tempfile.TemporaryDirectory() as td, \
             patch.object(redis, "HOME_DIR", Path(td)), \
             patch.object(redis, "stack_env", return_value={"REDIS_APP_ACL": "false", "REDIS_PASSWORD": "shared-secret"}):
            redis.ensure_redis_user("shop")
            values = parse_env_file(Path(td) / "shop" / ".credentials" / "redis.env")
            self.assertEqual(values["REDIS_USERNAME"], "")
            self.assertEqual(values["REDIS_PASSWORD"], "shared-secret")
            self.assertEqual(values["REDIS_PREFIX"], "shop:")

    def test_metadata_uses_db_zero(self) -> None:
        app = {}
        with patch.object(redis, "stack_env", return_value={"REDIS_APP_ACL": "true"}):
            redis.apply_app_redis_metadata(app, "shop", "credentials")
        self.assertEqual(app["redis_db"], 0)
        self.assertEqual(app["redis_user"], "shop")
        self.assertEqual(app["redis_prefix"], "shop:")
        self.assertEqual(app["redis_credentials"], "credentials")


if __name__ == "__main__":
    unittest.main()
