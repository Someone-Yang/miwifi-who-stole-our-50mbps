"""项目配置：从环境变量和项目根目录 .env 读取。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def load_dotenv(path: Path | None = None) -> None:
    """极简 .env 加载器，避免额外依赖；已存在的环境变量优先。"""
    env_path = path or (BASE_DIR / ".env")
    if not env_path.exists():
        return
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on", "y")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    host: str = "192.168.31.1"
    username: str = "admin"
    password: str = field(default="", repr=False)
    poll_interval: float = 2.0
    request_timeout: float = 6.0
    demo: bool = False
    bind: str = "127.0.0.1"
    port: int = 5000
    # 宽带套餐标称的最大上下行带宽（Mbps）。0 表示未配置。
    max_downlink_mbps: float = 100.0
    max_uplink_mbps: float = 20.0

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        host = os.environ.get("MIWIFI_HOST", "192.168.31.1").strip()
        if host.startswith("http://"):
            host = host[len("http://") :]
        if host.startswith("https://"):
            host = host[len("https://") :]
        host = host.rstrip("/") or "192.168.31.1"
        return cls(
            host=host,
            username=os.environ.get("MIWIFI_USERNAME", "admin").strip() or "admin",
            password=os.environ.get("MIWIFI_PASSWORD", ""),
            poll_interval=max(1.0, _env_float("MIWIFI_POLL_INTERVAL", 2.0)),
            request_timeout=max(2.0, _env_float("MIWIFI_TIMEOUT", 6.0)),
            demo=_env_bool("MIWIFI_DEMO", False),
            bind=os.environ.get("MIWIFI_BIND", "127.0.0.1").strip()
            or "127.0.0.1",
            port=int(_env_float("MIWIFI_PORT", 5000)),
            max_downlink_mbps=max(
                0.0, _env_float("MIWIFI_MAX_DOWNLINK_MBPS", 100.0)
            ),
            max_uplink_mbps=max(
                0.0, _env_float("MIWIFI_MAX_UPLINK_MBPS", 20.0)
            ),
        )
