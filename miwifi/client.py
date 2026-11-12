"""小米路由器（MiWiFi）本地管理接口客户端。

只使用路由器 Web 管理页自身的登录/查询接口，不依赖云端。
登录流程与官方 Web UI 一致：
  1. GET /cgi-bin/luci/web 获取 key、deviceId、newEncryptMode
  2. nonce = 0_<deviceId>_<unix秒>_<随机数>
  3. password = SHA256(nonce + SHA256(明文密码 + key))
  4. POST /cgi-bin/luci/api/xqsystem/login 获取 stok
  5. GET /cgi-bin/luci/;stok=<stok>/api/...
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import re
import threading
import time
from typing import Any, Optional

import requests

LOG = logging.getLogger(__name__)

DEFAULT_KEY = "a2ffa5c9be07488bbb04a3a47d3c5f6a"
DEFAULT_DEVICE_ID = "02:00:00:00:00:AA"
LOGIN_PAGE = "/cgi-bin/luci/web"
LOGIN_API = "/cgi-bin/luci/api/xqsystem/login"


class RouterError(RuntimeError):
    """路由器接口异常。"""


class RouterAuthError(RouterError):
    """登录失败或 token 失效且无法重新登录。"""


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _is_success_code(code: Any) -> bool:
    if code is None:
        return True
    try:
        return int(code) == 0
    except (TypeError, ValueError):
        return False


def _is_auth_error_code(code: Any) -> bool:
    try:
        return int(code) in (401, 403)
    except (TypeError, ValueError):
        return False


class MiWiFiClient:
    """一个轻量的、线程安全的小米路由器 API 客户端。"""

    def __init__(
        self,
        host: str = "192.168.31.1",
        password: str = "",
        username: str = "admin",
        timeout: float = 6.0,
        token_ttl: float = 900.0,
    ) -> None:
        host = (host or "192.168.31.1").strip().rstrip("/")
        if not host.startswith(("http://", "https://")):
            host = "http://" + host
        self.base_url = host
        self.password = password
        self.username = username or "admin"
        self.timeout = timeout
        self.token_ttl = token_ttl

        self._session = requests.Session()
        # 局域网直连，忽略系统代理，避免 HTTP_PROXY 把 192.168.31.1 转发出去。
        self._session.trust_env = False
        self._session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0 Safari/537.36"
                ),
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
            }
        )

        self._lock = threading.RLock()
        self._token: Optional[str] = None
        self._token_at = 0.0
        self._login_meta: Optional[tuple[str, str, int]] = None
        self._login_meta_at = 0.0

    # ------------------------------------------------------------------ 登录

    def _fetch_login_meta(self) -> tuple[str, str, int]:
        """从登录页解析 key、deviceId、newEncryptMode，并缓存 5 分钟。"""
        now = time.time()
        if self._login_meta and now - self._login_meta_at < 300:
            return self._login_meta

        resp = self._session.get(
            self.base_url + LOGIN_PAGE, timeout=self.timeout, verify=False
        )
        resp.raise_for_status()
        # 小米管理页固定 UTF-8，但部分固件不返回 charset，requests 会误判为 latin-1。
        resp.encoding = "utf-8"
        html = resp.text

        key_match = re.search(r"key\s*:\s*'([0-9a-fA-F]{32})'", html)
        device_match = re.search(r"deviceId\s*=\s*'([^']+)'", html)
        mode_match = re.search(r"newEncryptMode\s*=\s*parseInt\('(\d+)'\)", html)

        key = key_match.group(1) if key_match else DEFAULT_KEY
        device_id = device_match.group(1) if device_match else DEFAULT_DEVICE_ID
        new_mode = int(mode_match.group(1)) if mode_match else 1

        self._login_meta = (key, device_id, new_mode)
        self._login_meta_at = now
        return self._login_meta

    def login(self, force: bool = False) -> str:
        """获取（或复用）stok。线程安全。"""
        with self._lock:
            if (
                not force
                and self._token
                and time.time() - self._token_at < self.token_ttl
            ):
                return self._token

            if not self.password:
                raise RouterAuthError("未配置路由器管理密码（MIWIFI_PASSWORD）")

            key, device_id, new_mode = self._fetch_login_meta()
            nonce = f"0_{device_id}_{int(time.time())}_{random.randrange(10000)}"
            inner = _sha256(self.password + key)
            outer = _sha256(nonce + inner) if new_mode == 1 else _sha1(nonce + inner)

            payload = {
                "username": self.username,
                "password": outer,
                "logtype": 2,
                "nonce": nonce,
            }
            try:
                resp = self._session.post(
                    self.base_url + LOGIN_API,
                    data=payload,
                    timeout=self.timeout,
                    verify=False,
                )
            except requests.RequestException as exc:  # 不输出密码
                raise RouterError(f"连接路由器登录接口失败：{exc.__class__.__name__}") from exc

            if resp.status_code in (401, 403):
                raise RouterAuthError("路由器拒绝登录，请检查管理密码")
            resp.raise_for_status()
            resp.encoding = "utf-8"
            try:
                data = json.loads(resp.text)
            except (ValueError, TypeError) as exc:
                raise RouterError("路由器登录接口返回了无法解析的内容") from exc

            code = data.get("code")
            if not _is_success_code(code):
                msg = data.get("msg") or data.get("message") or f"code={code}"
                raise RouterAuthError(f"路由器登录失败：{msg}")

            token = data.get("token")
            if not token:
                raise RouterAuthError("路由器登录成功但没有返回 token")

            self._token = str(token)
            self._token_at = time.time()
            LOG.info("已登录小米路由器 %s", self.base_url)
            return self._token

    # ------------------------------------------------------------------ 请求

    def _get_json(
        self, path: str, params: Optional[dict[str, Any]] = None, relogin: bool = True
    ) -> dict[str, Any]:
        token = self.login()
        url = f"{self.base_url}/cgi-bin/luci/;stok={token}/api/{path.lstrip('/')}"
        try:
            resp = self._session.get(
                url, params=params, timeout=self.timeout, verify=False
            )
        except requests.RequestException as exc:
            raise RouterError(
                f"请求路由器接口失败（{path}）：{exc.__class__.__name__}"
            ) from exc

        if resp.status_code in (401, 403) and relogin:
            self.login(force=True)
            return self._get_json(path, params=params, relogin=False)
        resp.raise_for_status()
        resp.encoding = "utf-8"

        try:
            data = resp.json()
        except ValueError:
            # token 过期时部分固件返回登录页 HTML（HTTP 200）。
            if relogin:
                self.login(force=True)
                return self._get_json(path, params=params, relogin=False)
            raise RouterError(f"路由器接口 {path} 返回了非 JSON 内容")

        if not isinstance(data, dict):
            raise RouterError(f"路由器接口 {path} 返回格式异常")

        code = data.get("code")
        if _is_auth_error_code(code) and relogin:
            self.login(force=True)
            return self._get_json(path, params=params, relogin=False)
        if code is not None and not _is_success_code(code):
            msg = data.get("msg") or data.get("message") or f"code={code}"
            raise RouterError(f"路由器接口 {path} 返回错误：{msg}")
        return data

    # ------------------------------------------------------------------ 接口

    def get_status(self) -> dict[str, Any]:
        """系统状态：WAN 总量/速率、CPU/内存、设备累计流量（Top N）。"""
        return self._get_json("misystem/status")

    def get_devicelist(self) -> dict[str, Any]:
        """当前设备列表：名称、IP、在线状态、实时速率。"""
        return self._get_json("misystem/devicelist")

    def get_newstatus(self) -> dict[str, Any]:
        """精简状态：SSID、2.4G/5G 在线数、硬件信息。"""
        return self._get_json("misystem/newstatus")

    def get_router_name(self) -> dict[str, Any]:
        return self._get_json("xqsystem/router_name")

    def get_pppoe_status(self) -> dict[str, Any]:
        return self._get_json("xqnetwork/pppoe_status")

    def get_wan_info(self) -> dict[str, Any]:
        return self._get_json("xqnetwork/wan_info")

    def get_sys_time(self) -> dict[str, Any]:
        return self._get_json("misystem/sys_time")

    def close(self) -> None:
        self._session.close()
