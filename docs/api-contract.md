# 大屏数据接口契约

前端只依赖本文档定义的 JSON 结构。所有速率单位：**字节/秒（B/s）**；所有流量单位：**字节（B）**；时间戳为毫秒。

## GET `/api/overview`

返回当前快照。HTTP 200。后端每 2 秒从路由器采样一次，前端建议每 2 秒轮询。

```jsonc
{
  "ok": true,
  "source": "router",              // "router" 真实路由器 | "demo" 演示模式
  "stale": false,                  // true = 本次采样失败，内容为上一次成功快照
  "last_error": null,              // stale=true 时的简短中文错误
  "generated_at": "2026-11-11T13:05:00+08:00",
  "poll_interval_ms": 2000,
  "limits": {                      // 宽带套餐配置，用于计算上下行占用率
    "max_downlink_mbps": 100.0,
    "max_uplink_mbps": 20.0,
    "max_downlink_bps": 12500000,
    "max_uplink_bps": 2500000,
    "downlink_configured": true,
    "uplink_configured": true
  },
  "router": {
    "name": "MiWiFi-Home",
    "model": "Xiaomi路由器AX3000T",
    "platform": "RD03v2",
    "firmware": "2.0.28",
    "uptime_seconds": 19784,
    "wan": {
      "ip": "203.0.113.10",
      "gateway": "203.0.113.1",
      "proto": "pppoe",
      "download_total": 11563962620,
      "upload_total": 2871851997,
      "download_speed": 862185,
      "upload_speed": 58445,
      "max_download_speed": 6517471,
      "max_upload_speed": 1660169
    },
    "wifi": { "ssid": "MiWiFi-Home", "online_2g": 1, "online_5g": 11 },
    "clients_online": 12,
    "clients_total": 29,
    "cpu_load": 0.0,
    "mem_usage": 0.67,
    "temperature": 0
  },
  "summary": {
    "download_speed": 862185,
    "upload_speed": 58445,
    "device_download_speed": 871678,
    "device_upload_speed": 66467,
    "traffic_total": 14435814617,
    "online_devices": 12
  },
  "devices": [
    {
      "mac": "02:00:00:00:00:02",
      "name": "DESKTOP-DEMO",
      "ip": "192.168.31.112",
      "online": true,
      "download_speed": 716341,
      "upload_speed": 10167,
      "download_total": 5520950089,
      "upload_total": 181378888,
      "traffic_total": 5702328977,
      "traffic_source": "router",   // "router"=路由器累计计数 | "session"=本次监控累计
      "max_download_speed": 3584156,
      "max_upload_speed": 243039,
      "online_seconds": 10073,
      "type": 2
    }
  ],
  "others": null,                   // 兼容字段，当前恒为 null（原因见字段说明）
  "history": [                     // 最近约 3 分钟（90 个采样点），按时间升序
    { "t": 1762837500000, "down": 851203, "up": 60211, "device_count": 12 }
  ],
  "notes": [
    "累计流量为路由器开机以来统计",
    "部分终端路由器未返回累计流量，已按本次监控累计"
  ]
}
```

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `devices[].download_speed` / `upload_speed` | 当前实时下行 / 上行速率 |
| `devices[].traffic_total` | 累计流量 = `download_total + upload_total` |
| `devices[].traffic_source` | `router` 为路由器计数；`session` 为本次服务启动后的累计，界面需用「本次」角标区分 |
| `devices[].online_seconds` | 本次在线时长（秒） |
| `summary.download_speed` | WAN 口实时下行速率（通常略大于所有终端之和） |
| `summary.traffic_total` | WAN 口累计流量（路由器开机以来） |
| `history[].down` / `up` | WAN 实时速率采样，用于趋势图 |
| `limits.max_downlink_mbps` / `max_uplink_mbps` | 配置的宽带标称最大下行 / 上行带宽（Mbps） |
| `limits.max_downlink_bps` / `max_uplink_bps` | 换算后的最大下行 / 上行带宽（B/s = Mbps × 1,000,000 / 8） |
| `limits.downlink_configured` / `uplink_configured` | 对应方向是否已配置有效最大值；为 `false` 时前端应显示“未配置最大带宽” |
| `others` | 保留字段，当前恒为 `null`。`status.dev` 中无 MAC 的 “Others” 行是**未进入 Top N 的那几台在线设备**的流量汇总，而 `devicelist` 已包含这些设备；若把它再加进饼图会造成重复计数（实测 Others 速率与缺失设备速率之和完全相等）。 |

> 饼图与表格「实时占用」的分母统一为**在线设备实时速率之和**，不包含 `others`。
> 上下行占用率饼图以 `limits` 为分母：设备下行速率 / `max_downlink_bps`、设备上行速率 / `max_uplink_bps`；未占满的带宽以「空闲带宽」扇区补齐，使整圆代表 100% 最大带宽。
> 部分设备不在路由器流量 Top N 中，`traffic_total` 使用 `traffic_source=session` 的本机累计，并在界面标注「本次」。

## POST `/api/refresh`

强制立即采样一次，返回与 `/api/overview` 相同的 JSON。前端“立即刷新”按钮使用。

## GET `/api/health`

```json
{ "ok": true, "source": "router", "last_poll_ok": true, "last_poll_at": "2026-11-11T13:05:00+08:00", "devices": 12 }
```

## 失败形态

- 路由器不可达且尚无历史快照：`503`，`{ "ok": false, "error": "无法连接小米路由器", "detail": "无法连接小米路由器" }`。`detail` 为更具体的原因，可能为空字符串。
- 有历史快照但最新采样失败：`200`，`stale: true`，`last_error` 为简短原因。

## UI 约定

- 禁止把路由器密码、Wi-Fi 密码、PPPoE 账号等敏感字段发送到前端。
- 演示模式 `source === "demo"` 时顶部显示「演示数据」角标。
- 饼图默认按实时带宽 `(download_speed + upload_speed)` 计算占比；可切换为累计流量。
- 累计模式下环形图中心显示的是**在线设备已统计累计之和**（部分设备用 session 计数），不等于 WAN 累计总流量；WAN 总量以 `summary.traffic_total` 为准。
- 单位格式化：B/s、KB/s、MB/s；流量 B、KB、MB、GB、TB。
