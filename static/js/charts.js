/* 小米路由器网络监控大屏 · 原生 Canvas 图表
 * 提供 DonutChart（带宽占用环形图）与 TrendChart（实时速率趋势图）。
 * 无任何外部依赖，离线可用。
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var MONO_FONT = '"Cascadia Mono","Consolas","SFMono-Regular","Microsoft YaHei UI",monospace';
  var SANS_FONT = '"MiSans","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';

  function reducedMotion() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function fitCanvas(canvas) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function hexToRgba(hex, alpha) {
    var h = String(hex || '#22d3ee').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function niceCeil(v) {
    if (!(v > 0) || !isFinite(v)) return 1;
    var exp = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var f = v / exp;
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) {
      if (f <= steps[i]) return steps[i] * exp;
    }
    return 10 * exp;
  }

  /* ============================================================
   * 环形图
   * ========================================================== */
  function DonutChart(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.opts = opts;
    this.segments = [];
    this.display = [];
    this.hoverIndex = -1;
    this.selectedIndex = -1;
    this._geom = null;
    this._raf = 0;
    this._animFrom = null;
    this._animTo = null;
    this._animStart = 0;

    this._onMove = this._handleMove.bind(this);
    this._onLeave = this._handleLeave.bind(this);
    this._onClick = this._handleClick.bind(this);
    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);
    canvas.addEventListener('click', this._onClick);

    var target = canvas.parentElement || canvas;
    if (global.ResizeObserver) {
      this._ro = new global.ResizeObserver(this.draw.bind(this));
      this._ro.observe(target);
    } else {
      global.addEventListener('resize', this.draw.bind(this));
    }
    this.draw();
  }

  DonutChart.prototype.setData = function (segments) {
    var previous = {};
    for (var i = 0; i < this.segments.length; i++) {
      previous[this.segments[i].key] = this.display[i] || 0;
    }
    this.segments = (segments || []).slice();
    var target = this.segments.map(function (s) { return Math.max(0, Number(s.value) || 0); });
    var from = this.segments.map(function (s) {
      return Object.prototype.hasOwnProperty.call(previous, s.key) ? previous[s.key] : 0;
    });

    if (this.hoverIndex >= this.segments.length) this.hoverIndex = -1;
    if (this.selectedIndex >= this.segments.length) this.selectedIndex = -1;

    if (reducedMotion()) {
      this.display = target.slice();
      this.draw();
      return;
    }
    this._animFrom = from.slice();
    this._animTo = target.slice();
    this._animStart = global.performance ? global.performance.now() : Date.now();
    this.display = from.slice();
    this._loop();
  };

  DonutChart.prototype._loop = function () {
    var self = this;
    var duration = 560;
    if (this._raf) cancelAnimationFrame(this._raf);

    function tick() {
      var now = global.performance ? global.performance.now() : Date.now();
      var p = clamp((now - self._animStart) / duration, 0, 1);
      var e = easeOutCubic(p);
      self.display = self._animFrom.map(function (v, i) {
        return v + (self._animTo[i] - v) * e;
      });
      self.draw();
      if (p < 1) self._raf = requestAnimationFrame(tick);
      else self._raf = 0;
    }
    this._raf = requestAnimationFrame(tick);
  };

  DonutChart.prototype.draw = function () {
    var fit = fitCanvas(this.canvas);
    var ctx = fit.ctx;
    var w = fit.w;
    var h = fit.h;
    ctx.clearRect(0, 0, w, h);

    var cx = w / 2;
    var cy = h / 2;
    var size = Math.min(w, h);
    var outer = size / 2 - Math.max(7, size * 0.045);
    var inner = outer * 0.665;
    if (outer < 8) return;
    this._geom = { cx: cx, cy: cy, outer: outer, inner: inner };

    var total = 0;
    for (var t = 0; t < this.display.length; t++) total += this.display[t];

    // 底部轨道
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, (outer + inner) / 2, 0, TAU);
    ctx.lineWidth = outer - inner;
    ctx.strokeStyle = 'rgba(74,150,220,0.10)';
    ctx.stroke();
    ctx.restore();

    if (!(total > 0)) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, (outer + inner) / 2, 0, TAU);
      ctx.setLineDash([3, 6]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(103,232,249,0.22)';
      ctx.stroke();
      ctx.restore();
      return;
    }

    var gap = this.segments.length > 1 ? Math.min(0.022, 0.3 / this.segments.length) : 0;
    var angle = -Math.PI / 2;

    for (var i = 0; i < this.segments.length; i++) {
      var seg = this.segments[i];
      var span = (this.display[i] / total) * TAU;
      var hovered = this.hoverIndex === i;
      var selected = this.selectedIndex === i;
      var dimmed = (this.hoverIndex >= 0 && !hovered) ||
        (this.hoverIndex < 0 && this.selectedIndex >= 0 && !selected);

      if (span > 0.0008) {
        var a0 = angle + gap / 2;
        var a1 = angle + span - gap / 2;
        if (a1 <= a0) a1 = a0 + 0.004;
        var rOut = outer + (hovered ? 5 : (selected ? 2 : 0));

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.38 : 1;
        if (hovered) {
          ctx.shadowColor = seg.color;
          ctx.shadowBlur = 18;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, rOut, a0, a1);
        ctx.arc(cx, cy, inner, a1, a0, true);
        ctx.closePath();
        ctx.fillStyle = seg.color;
        ctx.fill();
        ctx.restore();

        if (!dimmed && !seg.idle) {
          var gloss = ctx.createLinearGradient(cx - outer, cy - outer, cx + outer, cy + outer);
          gloss.addColorStop(0, 'rgba(255,255,255,0.20)');
          gloss.addColorStop(0.38, 'rgba(255,255,255,0)');
          gloss.addColorStop(1, 'rgba(3,10,20,0.22)');
          ctx.beginPath();
          ctx.arc(cx, cy, rOut, a0, a1);
          ctx.arc(cx, cy, inner, a1, a0, true);
          ctx.closePath();
          ctx.fillStyle = gloss;
          ctx.fill();
        }

        if (selected) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, rOut - 0.75, a0, a1);
          ctx.arc(cx, cy, inner + 0.75, a1, a0, true);
          ctx.closePath();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        }
      }
      angle += span;
    }

    // 内圈细线
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, inner - 1, 0, TAU);
    ctx.strokeStyle = 'rgba(103,232,249,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  };

  DonutChart.prototype._indexAt = function (clientX, clientY) {
    var g = this._geom;
    if (!g || !this.segments.length) return -1;
    var rect = this.canvas.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    var dx = x - g.cx;
    var dy = y - g.cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < g.inner - 3 || dist > g.outer + 10) return -1;
    var total = 0;
    for (var i = 0; i < this.display.length; i++) total += this.display[i];
    if (!(total > 0)) return -1;
    var ang = Math.atan2(dy, dx) + Math.PI / 2;
    if (ang < 0) ang += TAU;
    var acc = 0;
    for (var j = 0; j < this.segments.length; j++) {
      var span = (this.display[j] / total) * TAU;
      if (ang >= acc && ang < acc + span) {
        // 空闲带宽扇区不可联动
        if (this.segments[j].interactive === false) return -1;
        return j;
      }
      acc += span;
    }
    var last = this.segments.length - 1;
    if (last >= 0 && this.segments[last].interactive === false) return -1;
    return last;
  };

  DonutChart.prototype._applyHover = function (index) {
    if (this.hoverIndex === index) return;
    this.hoverIndex = index;
    this.draw();
    if (this.opts.onHover) {
      this.opts.onHover(index, index >= 0 ? this.segments[index] : null);
    }
  };

  DonutChart.prototype.setHoverIndex = function (index) { this._applyHover(index); };

  DonutChart.prototype.setHoverByKey = function (key, silent) {
    var idx = -1;
    if (key) {
      for (var i = 0; i < this.segments.length; i++) {
        if (this.segments[i].key === key) { idx = i; break; }
      }
    }
    if (silent) {
      if (this.hoverIndex !== idx) {
        this.hoverIndex = idx;
        this.draw();
      }
      return;
    }
    this._applyHover(idx);
  };

  DonutChart.prototype.setSelectedByKey = function (key) {
    var idx = -1;
    if (key) {
      for (var i = 0; i < this.segments.length; i++) {
        if (this.segments[i].key === key) { idx = i; break; }
      }
    }
    if (this.selectedIndex === idx) return;
    this.selectedIndex = idx;
    this.draw();
  };

  DonutChart.prototype._handleMove = function (e) {
    this._applyHover(this._indexAt(e.clientX, e.clientY));
  };

  DonutChart.prototype._handleLeave = function () {
    this._applyHover(-1);
  };

  DonutChart.prototype._handleClick = function (e) {
    var idx = this._indexAt(e.clientX, e.clientY);
    if (idx < 0) return;
    if (this.selectedIndex === idx) this.selectedIndex = -1;
    else this.selectedIndex = idx;
    this.draw();
    if (this.opts.onSelect) {
      this.opts.onSelect(this.selectedIndex, this.selectedIndex >= 0 ? this.segments[this.selectedIndex] : null);
    }
  };

  /* ============================================================
   * 趋势图
   * ========================================================== */
  function TrendChart(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.opts = opts;
    this.points = [];
    this.display = [];
    this.hoverIndex = -1;
    this._layout = null;
    this._yMax = 1;
    this._raf = 0;
    this._from = null;
    this._to = null;
    this._start = 0;
    this._duration = 520;

    this._onMove = this._handleMove.bind(this);
    this._onLeave = this._handleLeave.bind(this);
    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);

    var target = canvas.parentElement || canvas;
    if (global.ResizeObserver) {
      this._ro = new global.ResizeObserver(this.draw.bind(this));
      this._ro.observe(target);
    } else {
      global.addEventListener('resize', this.draw.bind(this));
    }
    this.draw();
  }

  TrendChart.prototype.setData = function (raw) {
    var self = this;
    var pts = (raw || []).slice(-60).map(function (p) {
      return {
        t: Number(p && p.t) || 0,
        down: Math.max(0, Number(p && p.down) || 0),
        up: Math.max(0, Number(p && p.up) || 0)
      };
    });
    var previous = {};
    if (this.points.length && this.display.length === this.points.length) {
      for (var i = 0; i < this.points.length; i++) previous[this.points[i].t] = this.display[i];
    }
    this.points = pts;
    var from = pts.map(function (p) {
      var prev = previous[p.t];
      return prev ? { down: prev.down, up: prev.up } : { down: p.down, up: p.up };
    });
    var to = pts.map(function (p) { return { down: p.down, up: p.up }; });

    if (this.hoverIndex >= pts.length) this.hoverIndex = -1;
    if (reducedMotion() || !pts.length) {
      this.display = to;
      this.draw();
      return;
    }
    this._from = from;
    this._to = to;
    this._start = global.performance ? global.performance.now() : Date.now();
    if (this._raf) cancelAnimationFrame(this._raf);

    function tick() {
      var now = global.performance ? global.performance.now() : Date.now();
      var p = clamp((now - self._start) / self._duration, 0, 1);
      var e = easeOutCubic(p);
      self.display = self._from.map(function (v, i) {
        return {
          down: v.down + (self._to[i].down - v.down) * e,
          up: v.up + (self._to[i].up - v.up) * e
        };
      });
      self.draw();
      if (p < 1) self._raf = requestAnimationFrame(tick);
      else self._raf = 0;
    }
    this._raf = requestAnimationFrame(tick);
  };

  TrendChart.prototype._pill = function (ctx, anchorX, top, text, color, layout, yMin, yMax) {
    var fs = clamp(layout.w / 62, 10, 13);
    ctx.font = '600 ' + fs + 'px ' + MONO_FONT;
    var tw = ctx.measureText(text).width;
    var pw = tw + fs * 1.2;
    var ph = fs * 1.75;
    var x = clamp(anchorX - pw / 2, 3, layout.w - pw - 3);
    var minTop = yMin == null ? 3 : yMin;
    var maxTop = (yMax == null ? layout.h - 3 : yMax) - ph;
    var y = clamp(top, minTop, Math.max(minTop, maxTop));
    ctx.save();
    ctx.beginPath();
    var r = fs * 0.45;
    var x0 = x;
    var y0 = y;
    var w0 = pw;
    var h0 = ph;
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + w0, y0, x0 + w0, y0 + h0, r);
    ctx.arcTo(x0 + w0, y0 + h0, x0, y0 + h0, r);
    ctx.arcTo(x0, y0 + h0, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + w0, y0, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(5,13,24,0.90)';
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#e4f7ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + pw / 2, y + ph / 2 + 0.5);
    ctx.restore();
  };

  TrendChart.prototype.draw = function () {
    var fit = fitCanvas(this.canvas);
    var ctx = fit.ctx;
    var layoutW = fit.w;
    var layoutH = fit.h;
    ctx.clearRect(0, 0, layoutW, layoutH);

    var pts = this.points;
    var disp = this.display;
    if (!pts.length || !disp.length) {
      ctx.fillStyle = 'rgba(110,136,168,0.8)';
      ctx.font = '12px ' + SANS_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待趋势数据…', layoutW / 2, layoutH / 2);
      this._layout = null;
      return;
    }

    var fs = clamp(layoutW / 62, 10, 13);
    var maxV = 0;
    for (var i = 0; i < disp.length; i++) {
      if (disp[i].down > maxV) maxV = disp[i].down;
      if (disp[i].up > maxV) maxV = disp[i].up;
    }
    // Y 轴按展示单位取整，保证刻度为 8.0 / 6.0 / 4.0 这类整数
    var unitBase = maxV >= 1073741824 ? 1073741824 : (maxV >= 1048576 ? 1048576 : (maxV >= 1024 ? 1024 : 1));
    var yMax = niceCeil((maxV * 1.08 || 1024) / unitBase) * unitBase;
    this._yMax = yMax;

    var formatRate = this.opts.formatRate || function (v) { return String(v); };
    var formatTime = this.opts.formatTime || function (t) { return String(t); };

    ctx.font = fs + 'px ' + MONO_FONT;
    var yLabels = [];
    for (var g = 0; g <= 4; g++) yLabels.push(formatRate(yMax * (1 - g / 4)));
    var maxLabelW = 0;
    for (var lw = 0; lw < yLabels.length; lw++) {
      maxLabelW = Math.max(maxLabelW, ctx.measureText(yLabels[lw]).width);
    }

    var pad = {
      l: maxLabelW + fs * 1.2,
      r: fs * 0.7 + 4,
      t: fs * 2.0,
      b: fs * 2.1
    };
    var plotW = Math.max(10, layoutW - pad.l - pad.r);
    var plotH = Math.max(10, layoutH - pad.t - pad.b);
    var n = pts.length;
    var canvasW = layoutW;
    var canvasH = layoutH;
    var layout = { pad: pad, plotW: plotW, plotH: plotH, n: n, w: canvasW, h: canvasH };

    function xAt(idx) {
      return n <= 1 ? pad.l + plotW / 2 : pad.l + plotW * (idx / (n - 1));
    }
    function yAt(v) {
      return pad.t + plotH * (1 - clamp(v / yMax, 0, 1));
    }

    // 网格与 Y 轴
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.t + plotH * gi / 4;
      ctx.beginPath();
      ctx.setLineDash(gi === 4 ? [] : [2, 5]);
      ctx.strokeStyle = gi === 4 ? 'rgba(96,165,250,0.26)' : 'rgba(86,160,220,0.12)';
      ctx.lineWidth = 1;
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(pad.l + plotW, gy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(148,180,210,0.72)';
      ctx.fillText(yLabels[gi], pad.l - 8, gy);
    }

    // X 轴时间
    var labelCount = Math.min(n, clamp(Math.floor(plotW / 100), 2, 5));
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(120,152,182,0.72)';
    if (labelCount <= 1) {
      // 只有一个采样点时居中画一次，避免左右两个标签重叠成乱码。
      ctx.textAlign = 'center';
      ctx.fillText(formatTime(pts[0].t), pad.l + plotW / 2, pad.t + plotH + fs * 0.8);
    } else {
      for (var li = 0; li < labelCount; li++) {
        var idx = Math.round((n - 1) * li / (labelCount - 1));
        var lx = xAt(idx);
        ctx.textAlign = li === 0 ? 'left' : (li === labelCount - 1 ? 'right' : 'center');
        ctx.fillText(formatTime(pts[idx].t), lx, pad.t + plotH + fs * 0.8);
      }
    }

    // 序列
    function drawSeries(key, color, fillAlpha) {
      ctx.beginPath();
      ctx.moveTo(xAt(0), pad.t + plotH);
      for (var a = 0; a < disp.length; a++) ctx.lineTo(xAt(a), yAt(disp[a][key]));
      ctx.lineTo(xAt(disp.length - 1), pad.t + plotH);
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
      grad.addColorStop(0, hexToRgba(color, fillAlpha));
      grad.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      for (var b = 0; b < disp.length; b++) {
        var px = xAt(b);
        var py = yAt(disp[b][key]);
        if (b === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = 9;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    drawSeries('up', '#a78bfa', 0.16);
    drawSeries('down', '#22d3ee', 0.22);

    var last = disp.length - 1;
    var lastX = xAt(last);
    var lastDownY = yAt(disp[last].down);
    var lastUpY = yAt(disp[last].up);

    // 当前值标签（限制在绘图区内，避免压住坐标轴）
    var pillH = fs * 1.75;
    var plotTop = pad.t;
    var plotBottom = pad.t + plotH;
    var downTop = lastDownY - pillH - fs * 0.9;
    var upTop = lastUpY + fs * 0.9;
    if (upTop + pillH > plotBottom - 2) {
      var aboveTop = lastUpY - pillH - fs * 0.9;
      upTop = Math.abs(lastDownY - lastUpY) > pillH * 1.7
        ? aboveTop
        : plotBottom - pillH - 2;
    }
    this._pill(ctx, lastX, downTop, formatRate(disp[last].down), '#22d3ee', layout,
      plotTop + 2, plotBottom - 2);
    this._pill(ctx, lastX, upTop, formatRate(disp[last].up), '#a78bfa', layout,
      plotTop + 2, plotBottom - 2);

    // 当前点
    function dot(x, y, color) {
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, TAU);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
    }
    dot(lastX, lastDownY, '#22d3ee');
    dot(lastX, lastUpY, '#a78bfa');

    // 悬停十字线与点
    if (this.hoverIndex >= 0 && this.hoverIndex < n) {
      var hx = xAt(this.hoverIndex);
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(200,235,255,0.35)';
      ctx.lineWidth = 1;
      ctx.moveTo(hx, pad.t);
      ctx.lineTo(hx, pad.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      dot(hx, yAt(disp[this.hoverIndex].down), '#22d3ee');
      dot(hx, yAt(disp[this.hoverIndex].up), '#a78bfa');
      ctx.restore();
    }

    this._layout = layout;
    this._syncTooltip();
  };

  TrendChart.prototype._syncTooltip = function () {
    var tt = this.opts.tooltip;
    var layout = this._layout;
    if (!tt) return;
    if (!layout || this.hoverIndex < 0 || this.hoverIndex >= this.points.length) {
      tt.hidden = true;
      return;
    }
    var idx = this.hoverIndex;
    var point = this.points[idx];
    var disp = this.display[idx];
    var formatRate = this.opts.formatRate || function (v) { return String(v); };
    var formatTime = this.opts.formatTime || function (t) { return String(t); };

    var x = layout.n <= 1
      ? layout.pad.l + layout.plotW / 2
      : layout.pad.l + layout.plotW * (idx / (layout.n - 1));
    var yDown = layout.pad.t + layout.plotH * (1 - clamp(disp.down / this._yMax, 0, 1));
    var yUp = layout.pad.t + layout.plotH * (1 - clamp(disp.up / this._yMax, 0, 1));

    tt.hidden = false;
    tt.innerHTML =
      '<div class="tt-time">' + formatTime(point.t) + '</div>' +
      '<div class="tt-row tt-down"><i></i><span>下行</span><b>' + formatRate(disp.down) + '</b></div>' +
      '<div class="tt-row tt-up"><i></i><span>上行</span><b>' + formatRate(disp.up) + '</b></div>';

    var tw = tt.offsetWidth;
    var th = tt.offsetHeight;
    var left = x + 16;
    if (left + tw > layout.w - 4) left = x - 16 - tw;
    if (left < 4) left = 4;
    var top = Math.min(yDown, yUp) - th - 12;
    if (top < 2) top = Math.max(yDown, yUp) + 14;
    if (top + th > layout.h - 2) top = layout.h - th - 2;
    tt.style.left = left + 'px';
    tt.style.top = top + 'px';
  };

  TrendChart.prototype._handleMove = function (e) {
    var layout = this._layout;
    if (!layout || !this.points.length) return;
    var rect = this.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var ratio = (x - layout.pad.l) / layout.plotW;
    var idx = clamp(Math.round(ratio * (layout.n - 1)), 0, layout.n - 1);
    if (idx !== this.hoverIndex) {
      this.hoverIndex = idx;
      this.draw();
    } else {
      this._syncTooltip();
    }
  };

  TrendChart.prototype._handleLeave = function () {
    if (this.hoverIndex !== -1) {
      this.hoverIndex = -1;
      this.draw();
    }
    if (this.opts.tooltip) this.opts.tooltip.hidden = true;
  };

  global.DashboardCharts = {
    DonutChart: DonutChart,
    TrendChart: TrendChart
  };
})(window);
