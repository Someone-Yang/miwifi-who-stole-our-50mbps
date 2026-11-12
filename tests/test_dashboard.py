"""大屏后端测试：演示模式不依赖真实路由器。"""

from __future__ import annotations

import json
import unittest

from app import create_app
from config import Settings
from miwifi.service import DashboardService


class DemoServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings(demo=True, poll_interval=1.0)
        self.service = DashboardService(self.settings)
        self.service._poll_once(initial=True)

    def tearDown(self) -> None:
        self.service.stop()

    def test_snapshot_shape(self) -> None:
        snap = self.service.get_snapshot()
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["source"], "demo")
        self.assertFalse(snap["stale"])
        self.assertGreater(len(snap["devices"]), 0)
        self.assertIn("router", snap)
        self.assertIn("summary", snap)
        self.assertIn("history", snap)
        self.assertIn("limits", snap)
        self.assertEqual(snap["limits"]["max_downlink_mbps"], 100.0)
        self.assertEqual(snap["limits"]["max_uplink_mbps"], 20.0)
        self.assertEqual(snap["limits"]["max_downlink_bps"], 12_500_000)
        self.assertEqual(snap["limits"]["max_uplink_bps"], 2_500_000)
        self.assertTrue(snap["limits"]["downlink_configured"])
        self.assertEqual(len(snap["history"]), 1)

        speeds = [
            d["download_speed"] + d["upload_speed"] for d in snap["devices"]
        ]
        self.assertEqual(speeds, sorted(speeds, reverse=True))
        self.assertTrue(any(d["traffic_source"] == "session" for d in snap["devices"]))
        # status.dev 的 Others 是未进入 Top N 设备的汇总，不能再次计入饼图。
        self.assertIsNone(snap["others"])

    def test_health(self) -> None:
        health = self.service.get_health()
        self.assertTrue(health["ok"])
        self.assertTrue(health["last_poll_ok"])
        self.assertEqual(health["devices"], 12)

    def test_no_sensitive_fields_in_snapshot(self) -> None:
        raw = json.dumps(self.service.get_snapshot(), ensure_ascii=False).lower()
        for forbidden in ("password", "passwd", "username", "sn"):
            self.assertNotIn(f'"{forbidden}"', raw)


class LimitSettingsTests(unittest.TestCase):
    def test_custom_limits(self) -> None:
        service = DashboardService(
            Settings(demo=True, poll_interval=1.0, max_downlink_mbps=500, max_uplink_mbps=50)
        )
        try:
            service._poll_once(initial=True)
            limits = service.get_snapshot()["limits"]  # type: ignore[index]
            self.assertEqual(limits["max_downlink_mbps"], 500.0)
            self.assertEqual(limits["max_uplink_mbps"], 50.0)
            self.assertEqual(limits["max_downlink_bps"], 62_500_000)
            self.assertEqual(limits["max_uplink_bps"], 6_250_000)
            self.assertTrue(limits["downlink_configured"])
        finally:
            service.stop()

    def test_unconfigured_limits(self) -> None:
        service = DashboardService(
            Settings(demo=True, poll_interval=1.0, max_downlink_mbps=0, max_uplink_mbps=0)
        )
        try:
            service._poll_once(initial=True)
            limits = service.get_snapshot()["limits"]  # type: ignore[index]
            self.assertEqual(limits["max_downlink_bps"], 0)
            self.assertEqual(limits["max_uplink_bps"], 0)
            self.assertFalse(limits["downlink_configured"])
            self.assertFalse(limits["uplink_configured"])
        finally:
            service.stop()


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app(Settings(demo=True, poll_interval=1.0))
        cls.client = cls.app.test_client()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.app.extensions["dashboard_service"].stop()

    def test_overview(self) -> None:
        resp = self.client.get("/api/overview")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["source"], "demo")
        self.assertGreater(len(data["devices"]), 0)

    def test_index_page(self) -> None:
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn("小米", html)

    def test_health(self) -> None:
        resp = self.client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["ok"])

    def test_refresh(self) -> None:
        resp = self.client.post("/api/refresh")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["ok"])


class LiveRouterTests(unittest.TestCase):
    """设置 MIWIFI_LIVE_TEST=1 后运行真实路由器连通性测试。"""

    @unittest.skipUnless(
        __import__("os").environ.get("MIWIFI_LIVE_TEST") == "1",
        "设置 MIWIFI_LIVE_TEST=1 才运行真实路由器测试",
    )
    def test_login_and_status(self) -> None:
        settings = Settings.from_env()
        self.assertTrue(settings.password, "未配置 MIWIFI_PASSWORD")
        service = DashboardService(settings)
        service._poll_once(initial=True)
        snap = service.get_snapshot()
        service.stop()
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["source"], "router")
        self.assertGreater(len(snap["devices"]), 0)
        self.assertTrue(snap["router"]["model"])


if __name__ == "__main__":
    unittest.main()
