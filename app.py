"""小米路由器网络监控大屏 —— Flask 入口。"""

from __future__ import annotations

import logging
import os
from typing import Optional

from flask import Flask, jsonify, render_template

from config import Settings
from miwifi.service import DashboardService

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
LOG = logging.getLogger(__name__)


def create_app(settings: Optional[Settings] = None) -> Flask:
    settings = settings or Settings.from_env()
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.json.ensure_ascii = False
    app.config["SETTINGS"] = settings

    service = DashboardService(settings)
    app.extensions["dashboard_service"] = service
    service.start()

    @app.get("/")
    def index():
        return render_template(
            "index.html",
            poll_interval_ms=int(settings.poll_interval * 1000),
            demo=settings.demo,
        )

    @app.get("/api/overview")
    def api_overview():
        snapshot = service.get_snapshot()
        if snapshot is None:
            health = service.get_health()
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": health.get("last_error") or "暂时无法读取路由器数据",
                        "detail": health.get("last_error") or "",
                        "source": "demo" if settings.demo else "router",
                    }
                ),
                503,
            )
        return jsonify(snapshot)

    @app.post("/api/refresh")
    def api_refresh():
        snapshot = service.refresh_now()
        if snapshot is None:
            health = service.get_health()
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": health.get("last_error") or "暂时无法读取路由器数据",
                        "detail": health.get("last_error") or "",
                    }
                ),
                503,
            )
        return jsonify(snapshot)

    @app.get("/api/health")
    def api_health():
        return jsonify(service.get_health())

    @app.after_request
    def add_cache_headers(response):
        if response.content_type and "application/json" in response.content_type:
            response.headers["Cache-Control"] = "no-store"
        return response

    return app


if __name__ == "__main__":
    settings = Settings.from_env()
    app = create_app(settings)
    LOG.info(
        "大屏服务启动：http://%s:%s/ （数据源：%s）",
        "127.0.0.1" if settings.bind in ("0.0.0.0", "::") else settings.bind,
        settings.port,
        "演示模式" if settings.demo else settings.host,
    )
    app.run(
        host=settings.bind,
        port=settings.port,
        debug=False,
        threaded=True,
        use_reloader=False,
    )
