"""后台采样与数据整形：把路由器原始 JSON 变成大屏使用的快照。"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any, Optional

import requests

from config import Settings
from .client import MiWiFiClient, RouterAuthError, RouterError
from .demo import DemoSource

LOG = logging.getLogger(__name__)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class DashboardService:
    """维护一份线程安全的最新快照，并保留最近几分钟的速率历史。"""

    HISTORY_SIZE = 90  # 2 秒一个点，约 3 分钟

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._demo = DemoSource() if settings.demo else None
        self._client: Optional[MiWiFiClient] = None
        if self._demo is None:
            self._client = MiWiFiClient(
                host=settings.host,
                password=settings.password,
                username=settings.username,
                timeout=settings.request_timeout,
            )

        self._lock = threading.RLock()
        self._poll_lock = threading.Lock()
        self._snapshot: Optional[dict[str, Any]] = None
        self._history: deque[dict[str, Any]] = deque(maxlen=self.HISTORY_SIZE)
        self._session_traffic: dict[str, dict[str, int]] = {}
        self._static: dict[str, Any] = {}
        self._static_at = 0.0
        self._last_sample = 0.0
        self._last_success: Optional[float] = None
        self._last_poll_at: Optional[str] = None
        self._last_poll_ok = False
        self._last_error: Optional[str] = None
        self._next_poll_at = 0.0
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # ------------------------------------------------------------------ 生命周期

    def start(self) -> None:
        if self._thread is not None:
            return
        # 先同步采一次，保证首页打开就有数据；失败也不阻止服务启动。
        self._poll_once(initial=True)
        self._thread = threading.Thread(
            target=self._loop, name="miwifi-poller", daemon=True
        )
        self._thread.start()
        LOG.info(
            "数据采集已启动：host=%s demo=%s interval=%.1fs",
            self.settings.host,
            self.settings.demo,
            self.settings.poll_interval,
        )

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        if self._client:
            self._client.close()

    def _loop(self) -> None:
        while not self._stop.is_set():
            now = time.time()
            wait = max(0.1, self._next_poll_at - now)
            if self._stop.wait(wait):
                break
            try:
                self._poll_once()
            except Exception:  # pragma: no cover - 兜底，绝不让采集线程退出
                LOG.exception("采集循环出现未预期异常")
                self._next_poll_at = time.time() + self.settings.poll_interval

    # ------------------------------------------------------------------ 采样

    def _poll_once(self, initial: bool = False) -> None:
        with self._poll_lock:
            now = time.time()
            dt = (
                now - self._last_sample
                if self._last_sample
                else self.settings.poll_interval
            )
            self._last_sample = now
            self._last_poll_at = _now_iso()
            try:
                raw = self._demo.fetch() if self._demo else self._fetch_router(now)
                snapshot = self._build_snapshot(raw, now, dt)
            except Exception as exc:
                message = self._friendly_error(exc)
                LOG.warning("采样失败：%s (%s)", message, type(exc).__name__)
                with self._lock:
                    self._last_poll_ok = False
                    self._last_error = message
                    if self._snapshot is not None:
                        self._snapshot = {
                            **self._snapshot,
                            "stale": True,
                            "last_error": message,
                        }
                if isinstance(exc, RouterAuthError):
                    self._next_poll_at = time.time() + 30
                else:
                    # 以本轮开始时间排下一次采样，避免把请求耗时叠加到周期上。
                    self._next_poll_at = now + self.settings.poll_interval
                if initial:
                    LOG.warning("首次采样失败，前端将显示连接错误")
                return

            with self._lock:
                self._snapshot = snapshot
                self._last_poll_ok = True
                self._last_error = None
                self._last_success = now
            self._next_poll_at = now + self.settings.poll_interval
            if initial:
                LOG.info(
                    "首次采样成功：%s 台在线设备，WAN %.1f KB/s",
                    snapshot["summary"]["online_devices"],
                    snapshot["summary"]["download_speed"] / 1024,
                )

    def _fetch_router(self, now: float) -> dict[str, Any]:
        assert self._client is not None
        # 动态数据：每轮都取
        status = self._client.get_status()
        try:
            devicelist = self._client.get_devicelist()
        except RouterError as exc:
            LOG.warning("设备列表读取失败，将沿用上一次结果：%s", exc)
            devicelist = self._static.get("_last_devicelist") or {"list": []}
        else:
            self._static["_last_devicelist"] = devicelist

        # 静态数据：约每分钟刷新一次，失败不阻塞本轮
        if now - self._static_at >= 60 or not self._static:
            fetched: dict[str, Any] = {}
            for key, getter in (
                ("router_name", self._client.get_router_name),
                ("newstatus", self._client.get_newstatus),
                ("pppoe_status", self._client.get_pppoe_status),
                ("wan_info", self._client.get_wan_info),
            ):
                try:
                    fetched[key] = getter()
                except Exception as exc:
                    LOG.info("可选接口 %s 读取失败：%s", key, exc)
                    if key in self._static:
                        fetched[key] = self._static[key]
            self._static.update(fetched)
            self._static_at = now

        return {
            "status": status,
            "devicelist": devicelist,
            "router_name": self._static.get("router_name") or {},
            "newstatus": self._static.get("newstatus") or {},
            "pppoe_status": self._static.get("pppoe_status") or {},
            "wan_info": self._static.get("wan_info") or {},
        }

    # ------------------------------------------------------------------ 整形

    def _build_snapshot(
        self, raw: dict[str, Any], now: float, dt: float
    ) -> dict[str, Any]:
        status = raw.get("status") or {}
        devicelist = raw.get("devicelist") or {}
        newstatus = raw.get("newstatus") or {}
        pppoe = raw.get("pppoe_status") or {}
        wan_info = raw.get("wan_info") or {}
        router_name = raw.get("router_name") or {}

        wan = status.get("wan") or {}
        hw = status.get("hardware") or {}
        counts = status.get("count") or {}
        cpu = status.get("cpu") or {}
        mem = status.get("mem") or {}

        wan_down_speed = _as_int(wan.get("downspeed"))
        wan_up_speed = _as_int(wan.get("upspeed"))
        wan_download_total = _as_int(wan.get("download"))
        wan_upload_total = _as_int(wan.get("upload"))

        # 设备累计流量（路由器只返回流量 Top N，其余设备用本次监控累计补齐）
        # 注意：status.dev 中无 MAC 的 "Others" 行实际是「未进入 Top N 的那几台设备」
        # 的汇总；devicelist 已包含这些设备，若再把 Others 加回饼图会造成重复计数。
        stat_by_mac: dict[str, dict[str, Any]] = {}
        for item in status.get("dev") or []:
            mac = str(item.get("mac") or "").strip().upper()
            if not mac:
                continue
            stat_by_mac[mac] = item

        devices: list[dict[str, Any]] = []
        for item in devicelist.get("list") or []:
            if _as_int(item.get("online")) != 1:
                continue
            mac = str(item.get("mac") or "").strip().upper()
            if not mac:
                continue
            ip_entries = item.get("ip") or []
            ip0 = ip_entries[0] if ip_entries else {}
            stats = item.get("statistics") or {}
            down = _as_int(stats.get("downspeed"), _as_int(ip0.get("downspeed")))
            up = _as_int(stats.get("upspeed"), _as_int(ip0.get("upspeed")))
            stat = stat_by_mac.get(mac)

            if stat is not None:
                download_total = _as_int(stat.get("download"))
                upload_total = _as_int(stat.get("upload"))
                traffic_source = "router"
                max_down = _as_int(stat.get("maxdownloadspeed"))
                max_up = _as_int(stat.get("maxuploadspeed"))
                online_seconds = _as_int(stat.get("online")) or _as_int(
                    ip0.get("online")
                )
            else:
                accum = self._session_traffic.setdefault(
                    mac, {"download": 0, "upload": 0}
                )
                accum["download"] += int(max(0, down) * dt)
                accum["upload"] += int(max(0, up) * dt)
                download_total = accum["download"]
                upload_total = accum["upload"]
                traffic_source = "session"
                max_down = 0
                max_up = 0
                online_seconds = _as_int(ip0.get("online"))

            devices.append(
                {
                    "mac": mac,
                    "name": str(item.get("name") or item.get("oname") or mac),
                    "ip": str(ip0.get("ip") or ""),
                    "online": True,
                    "download_speed": max(0, down),
                    "upload_speed": max(0, up),
                    "download_total": download_total,
                    "upload_total": upload_total,
                    "traffic_total": download_total + upload_total,
                    "traffic_source": traffic_source,
                    "max_download_speed": max_down,
                    "max_upload_speed": max_up,
                    "online_seconds": online_seconds,
                    "type": _as_int(item.get("type")),
                }
            )

        devices.sort(
            key=lambda d: (d["download_speed"] + d["upload_speed"], d["traffic_total"]),
            reverse=True,
        )

        others = None
        device_down = sum(d["download_speed"] for d in devices)
        device_up = sum(d["upload_speed"] for d in devices)

        wifi_5g = newstatus.get("5g") or {}
        wifi_2g = newstatus.get("2g") or {}
        ssid = (
            wifi_5g.get("ssid")
            or wifi_2g.get("ssid")
            or ((newstatus.get("hardware") or {}).get("ssid"))
            or ""
        )

        wan_ip = ""
        ip_obj = pppoe.get("ip")
        if isinstance(ip_obj, dict):
            wan_ip = str(ip_obj.get("address") or "")
        elif isinstance(ip_obj, str):
            wan_ip = ip_obj
        if not wan_ip:
            info = wan_info.get("info") or {}
            wan_ip = str(info.get("ip") or info.get("ipaddr") or "")
        gateway = str(pppoe.get("gw") or "")
        proto = str(
            pppoe.get("proto")
            or ((wan_info.get("info") or {}).get("details") or {}).get("wanType")
            or "dhcp"
        )

        online_count = _as_int(counts.get("online"), len(devices))
        total_count = _as_int(counts.get("all"), online_count)

        cpu_load = _as_float(cpu.get("load"))
        mem_usage = _as_float(mem.get("usage"))
        if cpu_load > 1:  # 个别固件返回百分数
            cpu_load = cpu_load / 100.0
        if mem_usage > 1:
            mem_usage = mem_usage / 100.0

        history_entry = {
            "t": int(now * 1000),
            "down": wan_down_speed,
            "up": wan_up_speed,
            "device_count": len(devices),
        }
        with self._lock:
            self._history.append(history_entry)
            history = list(self._history)

        session_devices = [d for d in devices if d["traffic_source"] == "session"]
        notes = ["累计流量为路由器开机以来统计"]
        if session_devices:
            notes.append("部分终端路由器未返回累计流量，已按本次监控累计")

        return {
            "ok": True,
            "source": "demo" if self.settings.demo else "router",
            "stale": False,
            "last_error": None,
            "generated_at": _now_iso(),
            "poll_interval_ms": int(self.settings.poll_interval * 1000),
            "limits": self._build_limits(),
            "router": {
                "name": str(router_name.get("routerName") or "")
                or hw.get("displayName")
                or "小米路由器",
                "model": str(hw.get("displayName") or hw.get("platform") or "小米路由器"),
                "platform": str(hw.get("platform") or ""),
                "firmware": str(hw.get("version") or ""),
                "uptime_seconds": _as_int(status.get("upTime")),
                "wan": {
                    "ip": wan_ip,
                    "gateway": gateway,
                    "proto": proto,
                    "download_total": wan_download_total,
                    "upload_total": wan_upload_total,
                    "download_speed": wan_down_speed,
                    "upload_speed": wan_up_speed,
                    "max_download_speed": _as_int(wan.get("maxdownloadspeed")),
                    "max_upload_speed": _as_int(wan.get("maxuploadspeed")),
                },
                "wifi": {
                    "ssid": str(ssid or ""),
                    "online_2g": _as_int(wifi_2g.get("online_sta_count")),
                    "online_5g": _as_int(wifi_5g.get("online_sta_count")),
                },
                "clients_online": online_count,
                "clients_total": total_count,
                "cpu_load": round(cpu_load, 4),
                "mem_usage": round(mem_usage, 4),
                "temperature": _as_int(status.get("temperature")),
            },
            "summary": {
                "download_speed": wan_down_speed,
                "upload_speed": wan_up_speed,
                "device_download_speed": device_down,
                "device_upload_speed": device_up,
                "traffic_total": wan_download_total + wan_upload_total,
                "online_devices": len(devices),
            },
            "devices": devices,
            "others": others,
            "history": history,
            "notes": notes,
        }

    # ------------------------------------------------------------------ 对外

    def _build_limits(self) -> dict[str, Any]:
        """宽带套餐标称的最大上下行带宽，供前端计算占用率。

        Mbps 为十进制网络带宽；B/s 换算公式为 Mbps × 1,000,000 / 8。
        """
        down_mbps = max(0.0, float(self.settings.max_downlink_mbps))
        up_mbps = max(0.0, float(self.settings.max_uplink_mbps))
        return {
            "max_downlink_mbps": round(down_mbps, 3),
            "max_uplink_mbps": round(up_mbps, 3),
            "max_downlink_bps": int(down_mbps * 1_000_000 / 8),
            "max_uplink_bps": int(up_mbps * 1_000_000 / 8),
            "downlink_configured": down_mbps > 0,
            "uplink_configured": up_mbps > 0,
        }

    def _friendly_error(self, exc: Exception) -> str:
        text = str(exc)
        if isinstance(exc, RouterAuthError):
            return "路由器登录失败，请检查 MIWIFI_PASSWORD"
        if isinstance(exc, requests.Timeout) or "Timeout" in text or "timed out" in text:
            return "路由器响应超时"
        if isinstance(exc, requests.ConnectionError) or "Connection" in text:
            return "无法连接小米路由器"
        if isinstance(exc, RouterError):
            return text
        return "读取路由器数据失败"

    def get_snapshot(self) -> Optional[dict[str, Any]]:
        with self._lock:
            return self._snapshot

    def refresh_now(self) -> Optional[dict[str, Any]]:
        self._poll_once()
        return self.get_snapshot()

    def get_health(self) -> dict[str, Any]:
        snapshot = self.get_snapshot()
        with self._lock:
            return {
                "ok": snapshot is not None,
                "source": "demo" if self.settings.demo else "router",
                "last_poll_ok": self._last_poll_ok,
                "last_poll_at": self._last_poll_at,
                "last_error": self._last_error,
                "devices": len(snapshot.get("devices", [])) if snapshot else 0,
                "stale": bool(snapshot.get("stale")) if snapshot else False,
            }
