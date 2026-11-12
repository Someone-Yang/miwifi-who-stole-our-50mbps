/* 小米路由器网络监控大屏 · 数据轮询与视图渲染
 * 纯原生 JS，无外部依赖。每 2 秒轮询 GET /api/overview。
 */
(function () {
  'use strict';

  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var POLL_DEFAULT = 2000;
  var POLL_MAX_BACKOFF = 30000;
  var PALETTE = ['#22d3ee', '#3b82f6', '#a78bfa', '#2dd4bf', '#f59e0b', '#f472b6', '#4ade80', '#fb923c'];
  var OTHER_COLOR = '#5c7ea3';
  var IDLE_COLOR = '#26405c';
  var SORT_MODES = ['name', 'up', 'down', 'total'];

  var state = {
    data: null,
    hasData: false,
    failCount: 0,
    inFlight: false,
    timer: 0,
    lastSuccessAt: 0,
    lastGeneratedAt: 0,
    lastError: '',
    donutMetric: 'live',
    deviceSort: 'total',
    hoverKey: null,
    selectedKey: null,
    uptimeBaseSeconds: 0,
    uptimeBaseAt: 0
  };

  var rowMap = new Map();
  var activeTweens = [];
  var tweensScheduled = false;
  var toastTimer = 0;
  var legendKeys = { total: [], down: [], up: [] };
  var charts = {};

  function $(id) { return document.getElementById(id); }

  var els = {
    routerName: $('routerName'),
    routerModel: $('routerModel'),
    routerPlatform: $('routerPlatform'),
    routerFirmware: $('routerFirmware'),
    badgeOnline: $('badgeOnline'),
    ssid: $('ssid'),
    wanIp: $('wanIp'),
    wanProto: $('wanProto'),
    uptime: $('uptime'),
    clockTime: $('clockTime'),
    clockDate: $('clockDate'),
    badgeDemo: $('badgeDemo'),
    badgeStale: $('badgeStale'),
    badgeConn: $('badgeConn'),
    refreshBtn: $('refreshBtn'),
    kpiDevices: $('kpiDevices'),
    kpiDevFoot: $('kpiDevFoot'),
    kpiDownNum: $('kpiDownNum'),
    kpiDownUnit: $('kpiDownUnit'),
    kpiDownFoot: $('kpiDownFoot'),
    kpiUpNum: $('kpiUpNum'),
    kpiUpUnit: $('kpiUpUnit'),
    kpiUpFoot: $('kpiUpFoot'),
    kpiTotalNum: $('kpiTotalNum'),
    kpiTotalUnit: $('kpiTotalUnit'),
    kpiTotalFoot: $('kpiTotalFoot'),
    cpuBar: $('cpuBar'),
    cpuVal: $('cpuVal'),
    memBar: $('memBar'),
    memVal: $('memVal'),
    sysFoot: $('sysFoot'),
    deviceCount: $('deviceCount'),
    deviceBody: $('deviceBody'),
    dataNotes: $('dataNotes'),
    deviceSort: $('deviceSort'),
    donutValue: $('donutValue'),
    donutCaption: $('donutCaption'),
    donutSub: $('donutSub'),
    donutLegend: $('donutLegend'),
    downBody: $('downBody'),
    downCanvas: $('downCanvas'),
    downUsed: $('downUsed'),
    downCaption: $('downCaption'),
    downRate: $('downRate'),
    downLimitPill: $('downLimitPill'),
    downLegend: $('downLegend'),
    downEmpty: $('downEmpty'),
    upBody: $('upBody'),
    upCanvas: $('upCanvas'),
    upUsed: $('upUsed'),
    upCaption: $('upCaption'),
    upRate: $('upRate'),
    upLimitPill: $('upLimitPill'),
    upLegend: $('upLegend'),
    upEmpty: $('upEmpty'),
    trendWindow: $('trendWindow'),
    trendDown: $('trendDown'),
    trendUp: $('trendUp'),
    trendTooltip: $('trendTooltip'),
    footSource: $('footSource'),
    footInterval: $('footInterval'),
    footUpdated: $('footUpdated'),
    footAge: $('footAge'),
    footStatus: $('footStatus'),
    footDot: $('footDot'),
    toast: $('toast')
  };

  /* ------------------------- 格式化 ------------------------- */

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function fmtNum(n, digits) {
    if (!isFinite(n)) return '—';
    var fixed = Number(n).toFixed(digits == null ? 0 : digits);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function fmtInt(v) {
    if (v == null || v === '' || isNaN(Number(v))) return '—';
    return fmtNum(Number(v), 0);
  }

  function splitRate(v) {
    var n = Math.max(0, num(v));
    if (n < 1024) return { num: n, unit: 'B/s', digits: 0 };
    if (n < 1048576) return { num: n / 1024, unit: 'KB/s', digits: 1 };
    if (n < 1073741824) return { num: n / 1048576, unit: 'MB/s', digits: 2 };
    return { num: n / 1073741824, unit: 'GB/s', digits: 2 };
  }

  function fmtRate(v) {
    var s = splitRate(v);
    return fmtNum(s.num, s.digits) + ' ' + s.unit;
  }

  function splitTraffic(v) {
    var n = Math.max(0, num(v));
    if (n < 1024) return { num: n, unit: 'B', digits: 0 };
    if (n < 1048576) return { num: n / 1024, unit: 'KB', digits: 1 };
    if (n < 1073741824) return { num: n / 1048576, unit: 'MB', digits: 1 };
    if (n < 1099511627776) return { num: n / 1073741824, unit: 'GB', digits: 2 };
    return { num: n / 1099511627776, unit: 'TB', digits: 2 };
  }

  function fmtTraffic(v) {
    var s = splitTraffic(v);
    return fmtNum(s.num, s.digits) + ' ' + s.unit;
  }

  function fmtPct(p) {
    if (!isFinite(p) || p <= 0) return '0%';
    if (p >= 10) return Math.round(p) + '%';
    if (p >= 0.1) return p.toFixed(1) + '%';
    return '<0.1%';
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtClockTime(ms) {
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) return '--:--:--';
    var d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtUptime(seconds) {
    var s = Math.max(0, Math.floor(num(seconds)));
    var days = Math.floor(s / 86400);
    var hours = Math.floor((s % 86400) / 3600);
    var mins = Math.floor((s % 3600) / 60);
    var secs = s % 60;
    if (days > 0) return days + ' 天 ' + hours + ':' + pad2(mins) + ':' + pad2(secs);
    if (hours > 0) return hours + ':' + pad2(mins) + ':' + pad2(secs);
    return mins + ' 分 ' + pad2(secs) + ' 秒';
  }

  function protoLabel(proto) {
    var p = String(proto || '').toLowerCase();
    if (!p) return '—';
    if (p === 'pppoe') return 'PPPoE';
    if (p === 'dhcp') return 'DHCP';
    if (p === 'static') return '静态 IP';
    return p.toUpperCase();
  }

  function pctValue(v) {
    if (v == null || v === '' || isNaN(Number(v))) return null;
    var n = Number(v);
    if (n > 0 && n <= 1) n = n * 100;
    return Math.max(0, Math.min(100, n));
  }

  function fmtMbps(v) {
    var n = num(v);
    if (!(n > 0)) return '—';
    var digits = n >= 100 ? 0 : (n >= 10 ? 1 : 2);
    var text = fmtNum(n, digits);
    if (text.indexOf('.') >= 0) text = text.replace(/0+$/, '').replace(/\.$/, '');
    return text + ' Mbps';
  }

  function fmtUsedPct(p) {
    if (!isFinite(p) || p <= 0) return '0%';
    if (p >= 100) return Math.round(p) + '%';
    return fmtPct(p);
  }

  /* ------------------------- 数字补间 ------------------------- */

  function scheduleTweens() {
    if (tweensScheduled) return;
    tweensScheduled = true;
    requestAnimationFrame(stepTweens);
  }

  function stepTweens(now) {
    tweensScheduled = false;
    for (var i = activeTweens.length - 1; i >= 0; i--) {
      var el = activeTweens[i];
      var tw = el._tween;
      if (!tw) { activeTweens.splice(i, 1); continue; }
      var p = Math.min(1, (now - tw.start) / tw.dur);
      var e = 1 - Math.pow(1 - p, 3);
      var value = tw.from + (tw.to - tw.from) * e;
      el._animValue = value;
      tw.formatter(value);
      if (p >= 1) {
        el._animValue = tw.to;
        tw.formatter(tw.to);
        el._tween = null;
        activeTweens.splice(i, 1);
      }
    }
    if (activeTweens.length) scheduleTweens();
  }

  function tweenText(el, target, formatter) {
    if (!el) return;
    var to = num(target);
    var from = el._animValue;
    if (from == null || REDUCED || Math.abs(from - to) < 0.5) {
      el._animValue = to;
      formatter(to);
      return;
    }
    el._tween = {
      from: from,
      to: to,
      start: performance.now(),
      dur: 480,
      formatter: formatter
    };
    el._animValue = from;
    if (activeTweens.indexOf(el) === -1) activeTweens.push(el);
    scheduleTweens();
  }

  /* ------------------------- 状态与提示 ------------------------- */

  function setText(el, value) {
    if (el && el.textContent !== String(value)) el.textContent = String(value);
  }

  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.className = 'toast';
    }, 2600);
  }

  function updateStatus() {
    var data = state.data;
    var has = state.hasData;
    var stale = has && (state.failCount > 0 || !!(data && data.stale));

    els.badgeDemo.hidden = !(has && data && data.source === 'demo');
    els.badgeStale.hidden = !stale;
    els.badgeConn.hidden = has;

    if (has) {
      els.badgeOnline.hidden = false;
      if (stale) {
        setText(els.badgeOnline, '数据延迟');
        els.badgeOnline.className = 'badge badge-warn';
        els.footDot.className = 'foot-dot dot-warn';
        setText(els.footStatus, '数据已过期 · ' + (state.lastError || '接口采样失败') + ' · 重试中');
      } else {
        setText(els.badgeOnline, '在线');
        els.badgeOnline.className = 'badge badge-ok';
        els.footDot.className = 'foot-dot dot-ok';
        setText(els.footStatus, '数据实时刷新中');
      }
      return;
    }

    els.badgeOnline.hidden = true;
    els.footDot.className = 'foot-dot ' + (state.failCount > 0 ? 'dot-bad' : 'dot-muted');
    if (state.failCount > 0) {
      setText(els.badgeConn, '连接失败');
      els.badgeConn.className = 'badge badge-warn';
      setText(els.footStatus, '无法获取数据 · 第 ' + state.failCount + ' 次重试中');
    } else {
      setText(els.badgeConn, '连接中…');
      els.badgeConn.className = 'badge badge-muted';
      setText(els.footStatus, '正在连接后端…');
    }
  }

  /* ------------------------- 顶栏 ------------------------- */

  function renderHeader(data) {
    var router = data.router || {};
    var wifi = router.wifi || {};
    var wan = router.wan || {};

    setText(els.routerName, router.name || '小米路由器');
    setText(els.routerModel, router.model || '');
    setText(els.routerPlatform, router.platform || '—');
    setText(els.routerFirmware, router.firmware ? '固件 ' + router.firmware : '固件 —');
    setText(els.ssid, wifi.ssid || '—');
    setText(els.wanIp, wan.ip || '—');
    setText(els.wanProto, protoLabel(wan.proto));

    state.uptimeBaseSeconds = num(router.uptime_seconds);
    state.uptimeBaseAt = Date.now();
    setText(els.uptime, fmtUptime(state.uptimeBaseSeconds));
  }

  /* ------------------------- KPI ------------------------- */

  function renderKpis(data) {
    var summary = data.summary || {};
    var router = data.router || {};
    var wifi = router.wifi || {};
    var wan = router.wan || {};
    var list = onlineDevices(data);
    var online = summary.online_devices != null ? summary.online_devices : list.length;

    tweenText(els.kpiDevices, online, function (v) {
      els.kpiDevices.textContent = fmtInt(Math.round(v));
    });
    setText(els.kpiDevFoot,
      '共 ' + fmtInt(router.clients_total) + ' 台 · 5G ' +
      fmtInt(wifi.online_5g) + ' / 2.4G ' + fmtInt(wifi.online_2g));

    var down = summary.download_speed;
    if (down == null && data.history && data.history.length) {
      down = data.history[data.history.length - 1].down;
    }
    var up = summary.upload_speed;
    if (up == null && data.history && data.history.length) {
      up = data.history[data.history.length - 1].up;
    }

    tweenRate(els.kpiDownNum, els.kpiDownUnit, down);
    tweenRate(els.kpiUpNum, els.kpiUpUnit, up);
    setText(els.kpiDownFoot, '峰值 ' + (wan.max_download_speed != null ? fmtRate(wan.max_download_speed) : '—'));
    setText(els.kpiUpFoot, '峰值 ' + (wan.max_upload_speed != null ? fmtRate(wan.max_upload_speed) : '—'));

    tweenTraffic(els.kpiTotalNum, els.kpiTotalUnit, summary.traffic_total);
    var wanDownTotal = wan.download_total;
    var wanUpTotal = wan.upload_total;
    if (wanDownTotal == null && wanUpTotal == null) {
      setText(els.kpiTotalFoot, 'WAN 口累计流量');
    } else {
      setText(els.kpiTotalFoot,
        '下行 ' + fmtTraffic(wanDownTotal) + ' · 上行 ' + fmtTraffic(wanUpTotal));
    }

    var cpu = pctValue(router.cpu_load);
    var mem = pctValue(router.mem_usage);
    setMeter(els.cpuBar, els.cpuVal, cpu);
    setMeter(els.memBar, els.memVal, mem);
    var temp = num(router.temperature);
    setText(els.sysFoot, temp > 0 ? '温度 ' + fmtNum(temp, 1) + ' ℃' : 'CPU 负载 / 内存占用');
  }

  function tweenRate(numEl, unitEl, value) {
    tweenText(numEl, value, function (v) {
      var s = splitRate(v);
      numEl.textContent = fmtNum(s.num, s.digits);
      unitEl.textContent = s.unit;
    });
  }

  function tweenTraffic(numEl, unitEl, value) {
    tweenText(numEl, value, function (v) {
      var s = splitTraffic(v);
      numEl.textContent = fmtNum(s.num, s.digits);
      unitEl.textContent = s.unit;
    });
  }

  function setMeter(barEl, valEl, pct) {
    if (!barEl) return;
    if (pct == null) {
      barEl.style.width = '0%';
      barEl.removeAttribute('data-level');
      if (valEl) valEl.textContent = '—';
      return;
    }
    barEl.style.width = pct.toFixed(1) + '%';
    var level = pct >= 85 ? 'high' : (pct >= 60 ? 'mid' : 'low');
    barEl.setAttribute('data-level', level);
    if (valEl) valEl.textContent = fmtNum(pct, 0) + '%';
  }

  /* ------------------------- 设备表格 ------------------------- */

  function totalRate(d) {
    return num(d.download_speed) + num(d.upload_speed);
  }

  function onlineDevices(data) {
    return (data.devices || []).filter(function (d) {
      return d && d.online !== false;
    });
  }

  function deviceDisplayName(d) {
    var name = String(d.name || '').trim();
    var mac = String(d.mac || '').trim();
    if (!name || name.toUpperCase() === mac.toUpperCase()) return '未知设备';
    return name;
  }

  function deviceKey(d, index) {
    return String(d.mac || d.ip || ('dev-' + index));
  }

  // 环形图图例更紧凑：名字缺失时用 IP 尾号区分，避免出现多个“未知设备”
  function legendName(d) {
    var name = deviceDisplayName(d);
    if (name === '未知设备') {
      var ip = String(d.ip || '');
      var tail = ip.split('.').pop();
      if (tail && tail !== ip) return '未知设备 .' + tail;
    }
    return name;
  }

  /* ------------------------- 设备排序 ------------------------- */

  function compareName(a, b) {
    var an = deviceDisplayName(a);
    var bn = deviceDisplayName(b);
    var c = an.localeCompare(bn, 'zh-Hans-CN');
    if (c !== 0) return c;
    var t = totalRate(b) - totalRate(a);
    if (t !== 0) return t;
    return String(a.mac || '').localeCompare(String(b.mac || ''));
  }

  function compareByMode(key) {
    return function (a, b) {
      var d = num(b[key]) - num(a[key]);
      if (d !== 0) return d;
      return compareName(a, b);
    };
  }

  function sortDevices(list, mode) {
    var copy = list.slice();
    if (mode === 'name') {
      copy.sort(compareName);
    } else if (mode === 'down') {
      copy.sort(compareByMode('download_speed'));
    } else if (mode === 'up') {
      copy.sort(compareByMode('upload_speed'));
    } else {
      copy.sort(function (a, b) {
        var d = totalRate(b) - totalRate(a);
        if (d !== 0) return d;
        return compareName(a, b);
      });
    }
    return copy;
  }

  // 支持 ?sort=name / ?sort=down / ?sort=up / ?sort=total（便于截图与分享）
  function readSortMode() {
    try {
      var loc = window.location || {};
      var mode = '';
      if (window.URLSearchParams && loc.search) {
        mode = new window.URLSearchParams(loc.search).get('sort') || '';
      }
      if (!mode && loc.hash) {
        mode = String(loc.hash).replace(/^#(?:sort=)?/, '');
      }
      if (mode && SORT_MODES.indexOf(mode) >= 0) return mode;
    } catch (e) { /* 忽略 URL 解析失败 */ }
    return 'total';
  }

  /* ------------------------- 上下行占用率 ------------------------- */

  var OCC_TOP_N_WIDE = 8;
  var OCC_TOP_N_NARROW = 5;

  function occTopN() {
    return window.innerWidth >= 1601 ? OCC_TOP_N_WIDE : OCC_TOP_N_NARROW;
  }

  function occupancyInfo(data, dir) {
    var limits = data.limits || {};
    var maxMbps = num(dir === 'down' ? limits.max_downlink_mbps : limits.max_uplink_mbps);
    var maxBps = num(dir === 'down' ? limits.max_downlink_bps : limits.max_uplink_bps);
    var flag = dir === 'down' ? limits.downlink_configured : limits.uplink_configured;
    if (!(maxBps > 0) && maxMbps > 0) maxBps = maxMbps * 1000000 / 8;
    if (!(maxMbps > 0) && maxBps > 0) maxMbps = maxBps * 8 / 1000000;
    var configured = flag !== false && maxBps > 0 && isFinite(maxBps);
    return {
      dir: dir,
      configured: configured,
      maxBps: maxBps,
      maxMbps: maxMbps,
      label: fmtMbps(maxMbps)
    };
  }

  function buildOccupancy(list, info) {
    var speedKey = info.dir === 'down' ? 'download_speed' : 'upload_speed';
    var topN = occTopN();
    var items = [];
    list.forEach(function (d) {
      var value = num(d[speedKey]);
      if (value > 0) {
        items.push({ key: deviceKey(d, 0), name: legendName(d), value: value });
      }
    });
    items.sort(function (a, b) { return b.value - a.value; });

    var used = 0;
    for (var i = 0; i < items.length; i++) used += items[i].value;
    var idle = Math.max(0, info.maxBps - used);

    var top = items.slice(0, topN);
    var restValue = 0;
    for (var j = topN; j < items.length; j++) restValue += items[j].value;

    var segments = top.map(function (item, index) {
      return {
        key: item.key,
        name: item.name,
        value: item.value,
        color: PALETTE[index % PALETTE.length],
        interactive: true
      };
    });
    if (restValue > 0) {
      segments.push({
        key: '__other__',
        name: '其他设备（Top ' + topN + ' 之外）',
        value: restValue,
        color: OTHER_COLOR,
        interactive: true
      });
    }
    if (idle > 0) {
      segments.push({
        key: '__idle__',
        name: '空闲带宽',
        value: idle,
        color: IDLE_COLOR,
        interactive: false,
        idle: true
      });
    }
    return {
      used: used,
      idle: idle,
      ringTotal: used + idle,
      usedPct: info.maxBps > 0 ? (used / info.maxBps) * 100 : 0,
      segments: segments,
      deviceCount: items.length
    };
  }

  function setHoverEverywhere(key) {
    var list = [charts.donut, charts.down, charts.up];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) list[i].setHoverByKey(key, true);
    }
  }

  function setSelectedEverywhere(key) {
    var list = [charts.donut, charts.down, charts.up];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) list[i].setSelectedByKey(key);
    }
  }

  function handleChartHover(seg) {
    state.hoverKey = seg && seg.interactive !== false ? seg.key : null;
    setHoverEverywhere(state.hoverKey);
    applyLinkHighlights();
  }

  function handleChartSelect(seg) {
    state.selectedKey = seg && seg.interactive !== false ? seg.key : null;
    setSelectedEverywhere(state.selectedKey);
    applyLinkHighlights();
  }

  function bindRowEvents(row) {
    row.addEventListener('mouseenter', function () {
      state.hoverKey = row.dataset.key;
      setHoverEverywhere(state.hoverKey);
      applyLinkHighlights();
    });
    row.addEventListener('mouseleave', function () {
      if (state.hoverKey === row.dataset.key) state.hoverKey = null;
      setHoverEverywhere(null);
      applyLinkHighlights();
    });
    row.addEventListener('click', function () {
      toggleSelected(row.dataset.key);
    });
  }

  function createDeviceRow(key) {
    var tr = document.createElement('tr');
    tr.className = 'device-row';
    tr.dataset.key = key;
    tr.innerHTML =
      '<td class="td-dev">' +
        '<div class="dev-line"><i class="dev-dot"></i><span class="dev-name"></span></div>' +
        '<div class="dev-mac"></div>' +
      '</td>' +
      '<td class="td-ip mono"></td>' +
      '<td class="td-num td-down">—</td>' +
      '<td class="td-num td-up">—</td>' +
      '<td class="td-total"><span class="td-total-value">—</span>' +
        '<span class="badge-session" hidden title="本次监控启动后累计">本次</span></td>' +
      '<td class="td-share">' +
        '<div class="rate-bar"><i class="rate-bar-fill"></i></div>' +
        '<span class="share-pct">—</span>' +
      '</td>';
    bindRowEvents(tr);
    return tr;
  }

  function updateDeviceRow(row, d, meta) {
    var nameEl = row.querySelector('.dev-name');
    var displayName = deviceDisplayName(d);
    setText(nameEl, displayName);
    nameEl.title = displayName + (d.ip ? ' · ' + d.ip : '');
    setText(row.querySelector('.dev-mac'), d.mac || '—');
    setText(row.querySelector('.td-ip'), d.ip || '—');

    var downEl = row.querySelector('.td-down');
    var upEl = row.querySelector('.td-up');
    tweenText(downEl, d.download_speed, function (v) { downEl.textContent = fmtRate(v); });
    tweenText(upEl, d.upload_speed, function (v) { upEl.textContent = fmtRate(v); });

    var totalEl = row.querySelector('.td-total-value');
    tweenText(totalEl, d.traffic_total, function (v) { totalEl.textContent = fmtTraffic(v); });

    var sessionBadge = row.querySelector('.badge-session');
    sessionBadge.hidden = d.traffic_source !== 'session';

    var deviceTotal = totalRate(d);
    var share = meta.shareBase > 0 ? (deviceTotal / meta.shareBase) * 100 : 0;
    var width = meta.maxRate > 0 ? (deviceTotal / meta.maxRate) * 100 : 0;
    var fill = row.querySelector('.rate-bar-fill');
    fill.style.width = (deviceTotal > 0 ? Math.max(width, 2.5) : 0).toFixed(1) + '%';
    setText(row.querySelector('.share-pct'), deviceTotal > 0 ? fmtPct(share) : '—');
    row.querySelector('.dev-dot').classList.toggle('is-idle', deviceTotal < 1);
    row.title = displayName + ' · ' + (d.ip || '—') + ' · 占在线设备实时带宽 ' + fmtPct(share) +
      '（与环形图图例同口径）';
  }

  function renderDevices(data) {
    var list = sortDevices(onlineDevices(data), state.deviceSort);
    var tbody = els.deviceBody;
    // 与环形图统一口径：实时占用 = 设备实时速率 / 在线设备实时速率之和。
    // 不再叠加 status.dev 的 Others：它是未进入 Top N 设备的汇总，会重复计数。
    var shareBase = 0;
    var maxRate = 0;
    list.forEach(function (d) {
      var t = totalRate(d);
      shareBase += t;
      if (t > maxRate) maxRate = t;
    });

    var keep = {};
    list.forEach(function (d, index) {
      var key = deviceKey(d, index);
      keep[key] = true;
      var row = rowMap.get(key);
      if (!row) {
        row = createDeviceRow(key);
        rowMap.set(key, row);
      }
      row.dataset.order = String(index);
      updateDeviceRow(row, d, { shareBase: shareBase, maxRate: maxRate });
      tbody.appendChild(row);
    });

    rowMap.forEach(function (row, key) {
      if (!keep[key]) {
        row.remove();
        rowMap.delete(key);
      }
    });

    var emptyRow = tbody.querySelector('.empty-row');
    if (!list.length) {
      if (!emptyRow) {
        emptyRow = document.createElement('tr');
        emptyRow.className = 'empty-row';
        emptyRow.innerHTML = '<td colspan="6"></td>';
        tbody.appendChild(emptyRow);
      }
      emptyRow.firstElementChild.textContent = '暂无在线设备';
    } else if (emptyRow) {
      emptyRow.remove();
    }

    setText(els.deviceCount, list.length + ' 台在线');
    applyLinkHighlights();
  }

  function applyLinkHighlights() {
    rowMap.forEach(function (row, key) {
      row.classList.toggle('is-linked', key === state.hoverKey);
      row.classList.toggle('is-selected', key === state.selectedKey);
    });
    var legends = [els.donutLegend, els.downLegend, els.upLegend];
    for (var g = 0; g < legends.length; g++) {
      if (!legends[g]) continue;
      var items = legends[g].querySelectorAll('.legend-item');
      for (var i = 0; i < items.length; i++) {
        var key = items[i].getAttribute('data-key');
        items[i].classList.toggle('is-hover', key === state.hoverKey);
        items[i].classList.toggle('is-selected', key === state.selectedKey);
      }
    }
  }

  function toggleSelected(key) {
    if (!key) return;
    state.selectedKey = state.selectedKey === key ? null : key;
    setSelectedEverywhere(state.selectedKey);
    applyLinkHighlights();
  }

  /* ------------------------- 环形图 ------------------------- */

  function renderDonut(data) {
    var list = onlineDevices(data);
    var metric = state.donutMetric;
    var items = list.map(function (d) {
      var key = deviceKey(d, 0);
      var value = metric === 'live' ? totalRate(d) : num(d.traffic_total);
      return { key: key, name: legendName(d), value: value };
    }).filter(function (item) {
      return item.value > 0;
    });

    items.sort(function (a, b) { return b.value - a.value; });
    var top = items.slice(0, 8);
    var rest = items.slice(8);
    var restValue = rest.reduce(function (sum, item) { return sum + item.value; }, 0);

    var segments = top.map(function (item, index) {
      return {
        key: item.key,
        name: item.name,
        value: item.value,
        color: PALETTE[index % PALETTE.length]
      };
    });
    if (restValue > 0) {
      segments.push({
        key: '__other__',
        name: '其他设备（Top 8 之外）',
        value: restValue,
        color: OTHER_COLOR
      });
    }

    var total = segments.reduce(function (sum, seg) { return sum + seg.value; }, 0);

    if (metric === 'live') {
      setText(els.donutValue, fmtRate(total));
      setText(els.donutCaption, '当前总速率');
      setText(els.donutSub, '在线设备带宽占比');
    } else {
      setText(els.donutValue, fmtTraffic(total));
      setText(els.donutCaption, '在线设备累计');
      setText(els.donutSub, '已统计终端合计');
    }

    renderLegend(
      els.donutLegend, 'total', segments, total,
      metric === 'live' ? fmtRate : fmtTraffic, total, '暂无设备流量数据'
    );
    charts.donut.setData(segments);
    if (state.hoverKey) setHoverEverywhere(state.hoverKey);
    if (state.selectedKey) setSelectedEverywhere(state.selectedKey);
    applyLinkHighlights();
  }

  function bindLegendItem(li, seg) {
    if (seg.interactive === false) {
      li.classList.add('is-static');
      return;
    }
    li.addEventListener('mouseenter', function () {
      state.hoverKey = seg.key;
      setHoverEverywhere(seg.key);
      applyLinkHighlights();
    });
    li.addEventListener('mouseleave', function () {
      if (state.hoverKey === seg.key) state.hoverKey = null;
      setHoverEverywhere(null);
      applyLinkHighlights();
    });
    li.addEventListener('click', function () {
      toggleSelected(seg.key);
    });
  }

  function renderLegend(legendEl, storeKey, segments, ringTotal, formatValue, pctBase, emptyText) {
    if (!legendEl) return;
    var keys = segments.map(function (s) { return s.key; });
    var stored = legendKeys[storeKey] || [];
    var same = keys.length === stored.length && keys.every(function (k, i) { return k === stored[i]; });

    if (!segments.length) {
      legendKeys[storeKey] = [];
      legendEl.innerHTML = '<li class="legend-empty">' + (emptyText || '暂无数据') + '</li>';
      return;
    }

    function pctText(seg) {
      var base = pctBase != null ? pctBase : ringTotal;
      return fmtPct(base > 0 ? (seg.value / base) * 100 : 0);
    }

    if (same) {
      var existing = legendEl.querySelectorAll('.legend-item');
      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        var item = existing[i];
        if (!item) continue;
        item.style.setProperty('--sw', seg.color);
        item.classList.toggle('is-static', seg.interactive === false);
        item.querySelector('.legend-name').textContent = seg.name;
        item.querySelector('.legend-name').title = seg.name;
        item.querySelector('.legend-rate').textContent = formatValue(seg.value);
        item.querySelector('.legend-pct').textContent = pctText(seg);
      }
      return;
    }

    legendKeys[storeKey] = keys;
    legendEl.innerHTML = '';
    var fragment = document.createDocumentFragment();
    segments.forEach(function (seg) {
      var li = document.createElement('li');
      li.className = 'legend-item';
      li.setAttribute('data-key', seg.key);
      li.style.setProperty('--sw', seg.color);
      li.innerHTML =
        '<span class="legend-swatch"></span>' +
        '<span class="legend-name"></span>' +
        '<span class="legend-rate"></span>' +
        '<span class="legend-pct"></span>';
      li.querySelector('.legend-name').textContent = seg.name;
      li.querySelector('.legend-name').title = seg.name;
      li.querySelector('.legend-rate').textContent = formatValue(seg.value);
      li.querySelector('.legend-pct').textContent = pctText(seg);
      bindLegendItem(li, seg);
      fragment.appendChild(li);
    });
    legendEl.appendChild(fragment);
  }

  /* ------------------------- 上下行最大带宽占用率 ------------------------- */

  function renderOccupancy(data, dir) {
    var info = occupancyInfo(data, dir);
    var chart = dir === 'down' ? charts.down : charts.up;
    var refs = dir === 'down' ? {
      body: els.downBody,
      used: els.downUsed,
      caption: els.downCaption,
      rate: els.downRate,
      pill: els.downLimitPill,
      legend: els.downLegend,
      empty: els.downEmpty
    } : {
      body: els.upBody,
      used: els.upUsed,
      caption: els.upCaption,
      rate: els.upRate,
      pill: els.upLimitPill,
      legend: els.upLegend,
      empty: els.upEmpty
    };
    if (!refs.body) return;

    if (!info.configured) {
      refs.body.classList.add('is-empty');
      if (refs.empty) refs.empty.hidden = false;
      setText(refs.pill, '上限未配置');
      if (refs.pill) refs.pill.classList.add('is-warn');
      setText(refs.used, '—');
      setText(refs.caption, dir === 'down' ? '未配置下行带宽' : '未配置上行带宽');
      setText(refs.rate, '—');
      legendKeys[dir] = [];
      if (refs.legend) refs.legend.innerHTML = '<li class="legend-empty">未配置最大带宽</li>';
      if (chart) chart.setData([]);
      return;
    }

    refs.body.classList.remove('is-empty');
    if (refs.empty) refs.empty.hidden = true;
    setText(refs.pill, '上限 ' + info.label);
    if (refs.pill) refs.pill.classList.remove('is-warn');

    var built = buildOccupancy(onlineDevices(data), info);
    setText(refs.used, fmtUsedPct(built.usedPct));
    setText(refs.caption, dir === 'down' ? '已用下行带宽' : '已用上行带宽');
    setText(refs.rate, fmtRate(built.used) + ' / ' + info.label);
    renderLegend(
      refs.legend, dir, built.segments, built.ringTotal,
      fmtRate, info.maxBps, '暂无设备占用数据'
    );
    if (chart) chart.setData(built.segments);
    if (state.hoverKey) setHoverEverywhere(state.hoverKey);
    if (state.selectedKey) setSelectedEverywhere(state.selectedKey);
    applyLinkHighlights();
  }

  /* ------------------------- 趋势图 ------------------------- */

  function renderTrend(data) {
    var history = (data.history || []).slice(-60);
    var last = history.length ? history[history.length - 1] : null;
    var summary = data.summary || {};
    var down = summary.download_speed != null ? summary.download_speed : (last ? last.down : 0);
    var up = summary.upload_speed != null ? summary.upload_speed : (last ? last.up : 0);

    charts.trend.setData(history);
    setText(els.trendDown, fmtRate(down));
    setText(els.trendUp, fmtRate(up));
    setText(els.trendWindow, '最近 ' + history.length + ' 点');
  }

  /* ------------------------- 页脚 ------------------------- */

  function renderNotes(data) {
    if (!els.dataNotes) ensureNotesElement();
    if (!els.dataNotes) return;
    var notes = (data.notes || []).filter(function (note) {
      return typeof note === 'string' && note.trim();
    });
    var fallback = '累计流量为路由器开机以来统计；部分终端以「本次」标记的是监控启动后的累计值';
    var text = notes.length ? notes.join('；') : fallback;
    setText(els.dataNotes, text);
    els.dataNotes.title = text;
  }

  // 兼容后端模板缓存：若 HTML 中尚无数据说明条，则由前端补一个
  function ensureNotesElement() {
    var panel = document.querySelector('.devices-panel');
    if (!panel) return;
    var wrap = document.createElement('div');
    wrap.className = 'panel-note';
    wrap.innerHTML = '<span class="note-tag">数据说明</span>' +
      '<span class="note-text" id="dataNotes"></span>';
    panel.appendChild(wrap);
    els.dataNotes = wrap.querySelector('#dataNotes');
  }

  function renderFooter(data) {
    var router = data.router || {};
    var sourceText = data.source === 'demo'
      ? '数据来源：/api/overview · 演示模式（本地生成）'
      : '数据来源：/api/overview · ' + (router.model || '小米路由器');
    setText(els.footSource, sourceText);
    els.footSource.title = (data.notes || []).join('；') || '实时采样数据';

    var interval = num(data.poll_interval_ms) || POLL_DEFAULT;
    setText(els.footInterval, '刷新周期 ' + fmtNum(interval / 1000, 1).replace(/\.0$/, '') + ' 秒');
    setText(els.footUpdated, '最后更新 ' + fmtClockTime(state.lastGeneratedAt));
  }

  /* ------------------------- 快照处理 ------------------------- */

  function handleSnapshot(data) {
    state.data = data;
    state.hasData = true;
    state.lastSuccessAt = Date.now();
    state.failCount = 0;

    var generated = Date.parse(data.generated_at);
    state.lastGeneratedAt = isFinite(generated) && generated > 0 ? generated : Date.now();
    if (data.stale) state.lastError = data.last_error || '路由器采样失败';
    else state.lastError = '';

    renderHeader(data);
    renderKpis(data);
    renderDevices(data);
    renderDonut(data);
    renderOccupancy(data, 'down');
    renderOccupancy(data, 'up');
    renderTrend(data);
    renderNotes(data);
    renderFooter(data);
    updateStatus();
  }

  /* ------------------------- 轮询 ------------------------- */

  function schedule(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(poll, Math.max(500, delay));
  }

  function parseResponse(res) {
    return res.text().then(function (text) {
      var json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { res: res, json: json };
    });
  }

  function poll() {
    if (state.inFlight) {
      schedule(1000);
      return;
    }
    state.inFlight = true;
    fetch('/api/overview', {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }).then(parseResponse).then(function (r) {
      if (!r.res.ok) {
        var errMsg = r.json && (r.json.error || r.json.detail)
          ? (r.json.error || r.json.detail)
          : 'HTTP ' + r.res.status;
        throw new Error(errMsg);
      }
      if (!r.json || r.json.ok === false) {
        throw new Error(r.json && (r.json.error || '接口返回异常') || '接口返回异常');
      }
      handleSnapshot(r.json);
      schedule(num(r.json.poll_interval_ms) || POLL_DEFAULT);
    }).catch(function (err) {
      state.failCount += 1;
      state.lastError = err && err.message ? err.message : '网络异常';
      updateStatus();
      if (!state.hasData && els.deviceBody) {
        var emptyRow = els.deviceBody.querySelector('.empty-row');
        if (emptyRow) emptyRow.firstElementChild.textContent = '无法获取数据，正在重试…';
      }
      var backoff = Math.min(
        POLL_MAX_BACKOFF,
        POLL_DEFAULT * Math.pow(2, Math.min(state.failCount - 1, 4))
      );
      schedule(backoff);
    }).finally(function () {
      state.inFlight = false;
    });
  }

  function manualRefresh() {
    if (state.inFlight) {
      toast('正在刷新中，请稍候');
      return;
    }
    els.refreshBtn.classList.add('is-loading');
    els.refreshBtn.disabled = true;
    fetch('/api/refresh', {
      method: 'POST',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }).then(parseResponse).then(function (r) {
      if (!r.res.ok) throw new Error('HTTP ' + r.res.status);
      if (!r.json || r.json.ok === false) throw new Error(r.json && r.json.error || '刷新失败');
      handleSnapshot(r.json);
      schedule(num(r.json.poll_interval_ms) || POLL_DEFAULT);
      toast('已刷新：' + fmtClockTime(Date.now()));
    }).catch(function (err) {
      toast('刷新失败：' + (err && err.message ? err.message : '网络异常'));
    }).finally(function () {
      els.refreshBtn.classList.remove('is-loading');
      els.refreshBtn.disabled = false;
    });
  }

  /* ------------------------- 时钟与定时任务 ------------------------- */

  function tick() {
    var now = new Date();
    setText(els.clockTime,
      pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds()));
    setText(els.clockDate,
      now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) +
      ' 周' + '日一二三四五六'.charAt(now.getDay()));

    if (state.hasData) {
      var upSeconds = state.uptimeBaseSeconds + (Date.now() - state.uptimeBaseAt) / 1000;
      setText(els.uptime, fmtUptime(upSeconds));
      var age = Math.max(0, (Date.now() - state.lastGeneratedAt) / 1000);
      setText(els.footAge, age < 1 ? '（刚刚）' : '（' + Math.round(age) + ' 秒前）');
    }
    updateStatus();
  }

  /* ------------------------- 初始化 ------------------------- */

  function bindSegmented() {
    var buttons = document.querySelectorAll('.seg-btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var metric = this.getAttribute('data-metric');
        if (!metric || metric === state.donutMetric) return;
        state.donutMetric = metric;
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].classList.toggle('is-active', buttons[j] === this);
          buttons[j].setAttribute('aria-pressed', buttons[j] === this ? 'true' : 'false');
        }
        if (state.data) renderDonut(state.data);
      });
    }
  }

  function bindSortControl() {
    if (!els.deviceSort) return;
    els.deviceSort.value = state.deviceSort;
    els.deviceSort.addEventListener('change', function () {
      var mode = this.value;
      if (SORT_MODES.indexOf(mode) < 0) mode = 'total';
      if (mode === state.deviceSort) return;
      state.deviceSort = mode;
      // 纯前端重排，不重新请求接口；保留行元素、hover/选中与「本次」角标
      if (state.data) renderDevices(state.data);
    });
  }

  function init() {
    if (!window.DashboardCharts) {
      updateStatus();
      return;
    }

    var chartOptions = {
      onHover: function (index, seg) { handleChartHover(seg); },
      onSelect: function (index, seg) { handleChartSelect(seg); }
    };

    charts.donut = new window.DashboardCharts.DonutChart($('donutCanvas'), chartOptions);
    charts.down = new window.DashboardCharts.DonutChart(els.downCanvas || $('downCanvas'), chartOptions);
    charts.up = new window.DashboardCharts.DonutChart(els.upCanvas || $('upCanvas'), chartOptions);

    charts.trend = new window.DashboardCharts.TrendChart($('trendCanvas'), {
      tooltip: els.trendTooltip,
      formatRate: fmtRate,
      formatTime: fmtClockTime
    });

    state.deviceSort = readSortMode();
    bindSortControl();
    els.refreshBtn.addEventListener('click', manualRefresh);
    bindSegmented();
    tick();
    setInterval(tick, 1000);
    poll();
  }

  // 暴露少量纯函数，便于 Node 侧对排序/占用率算法做自动化校验
  window.DashboardUtils = {
    sortDevices: sortDevices,
    deviceDisplayName: deviceDisplayName,
    totalRate: totalRate,
    occupancyInfo: occupancyInfo,
    buildOccupancy: buildOccupancy,
    fmtMbps: fmtMbps,
    fmtUsedPct: fmtUsedPct,
    sortModes: SORT_MODES.slice()
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
