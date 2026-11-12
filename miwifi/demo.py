"""演示数据源：路由器不可达或未配置密码时用于预览大屏。"""

from __future__ import annotations

import math
import random
import time
from typing import Any

DEVICE_SEEDS = [
    # name, mac, ip, type, 基础下行 B/s, 基础上行 B/s, 初始累计下行 B, 初始累计上行 B
    ("客厅电视", "8C:53:C3:1A:2B:01", "192.168.31.101", 2, 2_850_000, 220_000, 82_400_000_000, 2_100_000_000),
    ("MacBook-Pro", "3C:22:FB:9D:7E:02", "192.168.31.102", 2, 1_420_000, 680_000, 51_300_000_000, 9_800_000_000),
    ("Phone-Demo-2", "02:00:00:00:00:01", "192.168.31.113", 2, 320_000, 42_000, 9_600_000_000, 860_000_000),
    ("DESKTOP-STUDY", "02:00:00:00:00:02", "192.168.31.112", 2, 610_000, 35_000, 36_200_000_000, 1_400_000_000),
    ("Pad-Demo", "02:00:00:00:00:04", "192.168.31.114", 2, 86_000, 12_000, 4_200_000_000, 210_000_000),
    ("Phone-Demo-3", "02:00:00:00:00:03", "192.168.31.115", 2, 54_000, 8_500, 2_900_000_000, 160_000_000),
    ("小爱音箱", "5C:E5:0C:11:22:03", "192.168.31.103", 2, 9_200, 3_400, 610_000_000, 190_000_000),
    ("NAS-存储", "00:11:32:AA:BB:04", "192.168.31.104", 1, 260_000, 120_000, 18_700_000_000, 5_600_000_000),
    ("家用摄像头", "A4:DA:22:CC:DD:05", "192.168.31.105", 2, 180_000, 4_000, 7_800_000_000, 90_000_000),
    ("iPhone-15", "F0:18:98:33:44:06", "192.168.31.106", 2, 48_000, 15_000, 3_100_000_000, 420_000_000),
    ("Switch", "98:B6:E9:55:66:07", "192.168.31.107", 2, 2_500, 18_000, 240_000_000, 38_000_000),
    ("扫地机器人", "50:EC:50:77:88:08", "192.168.31.121", 2, 1_200, 900, 90_000_000, 18_000_000),
]

# 这些设备不返回累计计数，用于展示“本次”角标
SESSION_ONLY = {"02:00:00:00:00:03", "02:00:00:00:00:04", "98:B6:E9:55:66:07"}


class DemoSource:
    """按正弦曲线生成平滑变化的模拟路由数据。"""

    def __init__(self) -> None:
        self.started = time.time()
        self.phase = [random.uniform(0, math.tau) for _ in DEVICE_SEEDS]
        self.totals = {
            seed[1]: [float(seed[6]), float(seed[7])] for seed in DEVICE_SEEDS
        }
        self.router_download = 612_000_000_000.0
        self.router_upload = 48_000_000_000.0
        self.last = time.time()

    def fetch(self) -> dict[str, Any]:
        now = time.time()
        dt = max(0.5, min(5.0, now - self.last))
        self.last = now
        elapsed = now - self.started
        devices = []
        dev_stats = []
        sum_down = 0
        sum_up = 0

        for idx, seed in enumerate(DEVICE_SEEDS):
            name, mac, ip, dtype, base_down, base_up, _, _ = seed
            wave = 0.55 + 0.45 * math.sin(elapsed / 7.0 + self.phase[idx])
            spike = 1.45 if idx in (3, 8) else 1.0
            down = max(0, int(base_down * wave * spike))
            up = max(
                0,
                int(
                    base_up
                    * (0.65 + 0.35 * math.cos(elapsed / 9.0 + self.phase[idx]))
                ),
            )
            self.totals[mac][0] += down * dt
            self.totals[mac][1] += up * dt
            sum_down += down
            sum_up += up

            devices.append(
                {
                    "name": name,
                    "mac": mac,
                    "ip": [
                        {
                            "ip": ip,
                            "downspeed": str(down),
                            "upspeed": str(up),
                            "online": str(int(elapsed) + 120),
                            "active": 1,
                        }
                    ],
                    "online": 1,
                    "statistics": {
                        "downspeed": str(down),
                        "upspeed": str(up),
                        "online": str(int(elapsed) + 120),
                    },
                    "type": dtype,
                    "isap": 0,
                    "parent": "",
                    "authority": {"wan": 1},
                }
            )

            if mac not in SESSION_ONLY:
                dev_stats.append(
                    {
                        "mac": mac,
                        "devname": name,
                        "downspeed": str(down),
                        "upspeed": str(up),
                        "download": str(int(self.totals[mac][0])),
                        "upload": str(int(self.totals[mac][1])),
                        "maxdownloadspeed": str(int(base_down * 4.2)),
                        "maxuploadspeed": str(int(base_up * 3.5)),
                        "online": str(int(elapsed) + 120),
                        "isap": 0,
                    }
                )

        wan_down = int(sum_down * 1.03 + 18_000)
        wan_up = int(sum_up * 1.02 + 2_600)
        self.router_download += wan_down * dt
        self.router_upload += wan_up * dt
        utime = int(elapsed) + 19_784

        return {
            "status": {
                "code": 0,
                "wan": {
                    "downspeed": str(wan_down),
                    "upspeed": str(wan_up),
                    "download": str(int(self.router_download)),
                    "upload": str(int(self.router_upload)),
                    "maxdownloadspeed": "93625174",
                    "maxuploadspeed": "38421680",
                    "devname": "eth1.4",
                },
                "hardware": {
                    "displayName": "Xiaomi路由器AX3000T",
                    "platform": "RD03v2",
                    "version": "2.0.28",
                    "mac": "02:00:00:00:00:AA",
                    "sn": "DEMO000000",
                },
                "upTime": f"{utime}.00",
                "cpu": {"core": 2, "hz": "1000MHz", "load": 0.13},
                "mem": {
                    "usage": 0.58,
                    "total": "256MB",
                    "hz": "1333MHz",
                    "type": "DDR3",
                },
                "temperature": 42,
                "count": {
                    "all": 29,
                    "online": len(devices),
                    "all_without_mash": 29,
                    "online_without_mash": len(devices),
                },
                "dev": dev_stats
                + [
                    {
                        "mac": "",
                        "devname": "Others",
                        "download": "92235440",
                        "upload": "6445402",
                        "downspeed": str(int(14_000 + 6_000 * math.sin(elapsed / 5))),
                        "upspeed": str(int(2_100 + 900 * math.cos(elapsed / 6))),
                        "maxdownloadspeed": "4300000",
                        "maxuploadspeed": "980000",
                        "online": "0",
                    }
                ],
            },
            "devicelist": {
                "code": 0,
                "mac": "02:00:00:00:00:AA",
                "list": devices,
            },
            "newstatus": {
                "code": 0,
                "count": len(devices),
                "hardware": {
                    "displayName": "Xiaomi路由器AX3000T",
                    "platform": "RD03v2",
                    "version": "2.0.28",
                },
                "2g": {
                    "online_sta_count": 3,
                    "ssid": "MiHome_5G",
                    "ssidHtmlEncode": 1,
                },
                "5g": {
                    "online_sta_count": 9,
                    "ssid": "MiHome_5G",
                    "ssidHtmlEncode": 1,
                },
            },
            "router_name": {"code": 0, "routerName": "MiWiFi-DEMO"},
            "pppoe_status": {
                "code": 0,
                "status": 2,
                "proto": "pppoe",
                "ip": {"address": "203.0.113.88", "mask": "255.255.255.255"},
                "gw": "203.0.113.1",
                "dns": ["223.5.5.5", "119.29.29.29"],
            },
        }
