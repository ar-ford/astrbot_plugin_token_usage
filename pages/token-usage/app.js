import { renderAreaChart, renderStackedChart } from "./charts.js";

const RANGES = [30, 90, 180, 365];
const DEFAULT_RANGE = 30;
const OTHER_SERIES = "__other__";
const SERIES_COLORS = [
  "#3c96ca",
  "#00C49F",
  "#FEB019",
  "#FF6B45",
  "#775DD0",
  "#8BC34A",
  "#D65AD1",
  "#2ED5C4",
  "#FF5CA8",
  "#2E7D32",
];
const OTHER_COLOR = "#9aa4ad";
const REFRESH_INTERVAL_MS = 60_000;

const state = {
  bridge: null,
  days: DEFAULT_RANGE,
  data: null,
  loading: false,
  error: "",
  lastLoadedAt: 0,
  locale: "zh-CN",
  isDark: false,
  refreshTimer: 0,
  pendingLoad: false,
};

const dom = {};

function $(id) {
  return document.getElementById(id);
}

function t(key, fallback, variables) {
  let text = fallback;
  try {
    if (state.bridge && typeof state.bridge.t === "function") {
      const translated = state.bridge.t(`views.token-usage.${key}`, fallback);
      if (typeof translated === "string" && translated) text = translated;
    }
  } catch {
    // 回退到内置中文文案。
  }
  if (variables) {
    text = text.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(variables, name)
        ? String(variables[name])
        : match,
    );
  }
  return text;
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatNumber(value) {
  try {
    return new Intl.NumberFormat(state.locale).format(Number(value) || 0);
  } catch {
    return String(Math.round(Number(value) || 0));
  }
}

function compactNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(2)}K`;
  return formatNumber(number);
}

function formatPercent(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatTpm(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  return `${Math.round(number)} TPM`;
}

function truncateMiddle(text, head = 18, tail = 10) {
  const value = String(text || "");
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function rangeLabel(days = state.days) {
  if (days >= 365) return t("ranges.oneYear", "近 1 年");
  return t("ranges.days", "近 {days} 天", { days });
}

function getThemeColor(name) {
  try {
    return (
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
      ""
    );
  } catch {
    return "";
  }
}

function icon(name) {
  const wrap = document.createElement("div");
  wrap.className = "card-icon";
  const paths = {
    tokens:
      '<circle cx="12" cy="12" r="8"/><path d="M9 10h6M9 14h4"/>',
    today:
      '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
    calls:
      '<path d="M4 18V9M10 18V5M16 18v-6M22 18V7"/>',
    success:
      '<path d="M5 13l4 4L19 7"/>',
    ttft:
      '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/>',
    sessions:
      '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M15 20c.3-2.8 2-4.6 4.5-4.6"/>',
  };
  wrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
  return wrap;
}

function setLoading(loading) {
  state.loading = loading;
  if (!dom.loading) return;
  dom.loading.classList.toggle("hidden", !loading);
  if (loading && !state.data) dom.content.classList.add("hidden");
}

function hideError() {
  state.error = "";
  if (!dom.error) return;
  dom.error.classList.add("hidden");
}

function showError(message) {
  state.error = message;
  if (!dom.error) return;
  dom.errorText.textContent = message;
  dom.error.classList.remove("hidden");
}

function applyContext(context) {
  if (!context || typeof context !== "object") return;
  if (typeof context.locale === "string" && context.locale) {
    state.locale = context.locale;
  }
  if (typeof context.isDark === "boolean") {
    state.isDark = context.isDark;
  }
  document.documentElement.setAttribute(
    "data-theme",
    state.isDark ? "dark" : "light",
  );
  document.documentElement.lang = state.locale;
}

function renderHeader() {
  document.title = t("pageTitle", "Token 用量统计");
  if (dom.title) dom.title.textContent = t("pageTitle", "Token 用量统计");
  if (dom.subtitle) {
    dom.subtitle.textContent = t(
      "subtitle",
      "{range} · {timezone} 时区 · 数据来自 AstrBot 模型调用记录",
      {
        range: rangeLabel(),
        timezone: state.data?.timezone || t("localTimezone", "本地"),
      },
    );
  }
  if (dom.refresh) {
    dom.refresh.title = t("refresh", "刷新");
    dom.refresh.setAttribute("aria-label", t("refresh", "刷新"));
  }
  if (dom.updatedAt) {
    const time = state.lastLoadedAt
      ? new Date(state.lastLoadedAt).toLocaleTimeString(state.locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "";
    dom.updatedAt.textContent = time
      ? t("updatedAt", "更新于 {time}", { time })
      : "";
  }
}

function renderRangeSwitch() {
  if (!dom.rangeSwitch) return;
  const buttons = RANGES.map((days) => {
    const button = createElement(
      "button",
      `range-chip${days === state.days ? " active" : ""}`,
      days >= 365 ? t("ranges.oneYearShort", "1 年") : t("ranges.daysShort", "{days} 天", { days }),
    );
    button.type = "button";
    button.setAttribute("aria-pressed", String(days === state.days));
    button.addEventListener("click", () => {
      if (state.days === days) return;
      state.days = days;
      renderRangeSwitch();
      void load({ silent: false });
    });
    return button;
  });
  dom.rangeSwitch.replaceChildren(...buttons);
}

function renderOverview(data) {
  if (!dom.overview) return;
  const totals = data?.totals || {};
  const today = data?.today || {};
  const cards = [
    {
      icon: "tokens",
      label: t("cards.rangeTokens", "{range} Tokens", { range: rangeLabel() }),
      value: compactNumber(totals.tokens),
      title: formatNumber(totals.tokens),
    },
    {
      icon: "today",
      label: t("cards.todayTokens", "今日 Tokens"),
      value: compactNumber(today.tokens),
      title: formatNumber(today.tokens),
    },
    {
      icon: "calls",
      label: t("cards.calls", "调用次数"),
      value: formatNumber(totals.calls),
      title: formatNumber(totals.calls),
    },
    {
      icon: "success",
      label: t("cards.successRate", "成功率"),
      value: totals.calls ? formatPercent(totals.success_rate) : "—",
      title: t("cards.errorsTitle", "{count} 次失败调用", {
        count: formatNumber(totals.errors),
      }),
    },
    {
      icon: "ttft",
      label: t("cards.avgTtft", "平均首字耗时"),
      value: formatDuration(totals.avg_ttft_ms),
      title: formatDuration(totals.avg_ttft_ms),
    },
    {
      icon: "sessions",
      label: t("cards.sessions", "活跃会话"),
      value: formatNumber(totals.sessions),
      title: formatNumber(totals.sessions),
    },
  ];
  const nodes = cards.map((card) => {
    const section = createElement("section", "stat-card overview-card");
    section.appendChild(icon(card.icon));
    section.appendChild(createElement("div", "card-label", card.label));
    const value = createElement("div", "card-value", card.value);
    if (card.title) value.title = card.title;
    section.appendChild(value);
    return section;
  });
  dom.overview.replaceChildren(...nodes);
}

function renderRankList(container, items, emptyText, options = {}) {
  if (!container) return;
  if (!items || !items.length) {
    container.replaceChildren(createElement("div", "empty-state", emptyText));
    return;
  }
  const rows = items.map((item) => {
    const row = createElement("div", "rank-row");
    const identity = createElement("div", "rank-identity");
    if (options.platform) {
      const platform = item.platform || String(item.umo || "").split(":", 1)[0];
      identity.appendChild(createElement("span", "platform-chip", platform || "unknown"));
    }
    const name = createElement(
      "span",
      "rank-name",
      options.name ? options.name(item) : String(item.name || item.provider_id || item.model || ""),
    );
    if (options.fullName) {
      const fullName = options.fullName(item);
      if (fullName) name.title = fullName;
    }
    identity.appendChild(name);
    row.appendChild(identity);
    const value = createElement("strong", "rank-value", options.value(item));
    if (options.fullValue) value.title = options.fullValue(item);
    row.appendChild(value);
    return row;
  });
  container.replaceChildren(...rows);
}

function renderRankings(data) {
  const providerItems = (data?.by_provider || []).slice(0, 6).map((item) => ({
    ...item,
    name: item.provider_id,
  }));
  renderRankList(
    dom.providerRank,
    providerItems,
    t("empty.providers", "暂无服务商调用记录"),
    {
      value: (item) => compactNumber(item.tokens),
      fullValue: (item) =>
        t("rankDetail", "{tokens} Tokens · {calls} 次调用 · 占比 {share}", {
          tokens: formatNumber(item.tokens),
          calls: formatNumber(item.calls),
          share: formatPercent(item.share),
        }),
      fullName: (item) => item.provider_id,
    },
  );

  const modelItems = (data?.by_model || []).slice(0, 10).map((item) => ({
    ...item,
    name: item.model,
  }));
  renderRankList(
    dom.modelRank,
    modelItems,
    t("empty.models", "暂无模型调用记录"),
    {
      value: (item) => compactNumber(item.tokens),
      fullValue: (item) =>
        t("rankDetail", "{tokens} Tokens · {calls} 次调用 · 占比 {share}", {
          tokens: formatNumber(item.tokens),
          calls: formatNumber(item.calls),
          share: formatPercent(item.share),
        }),
      fullName: (item) => `${item.provider_id} · ${item.model}`,
    },
  );

  const sessionItems = (data?.by_session || []).slice(0, 10).map((item) => ({
    ...item,
    name: item.display_name || truncateMiddle(item.umo),
  }));
  renderRankList(
    dom.sessionRank,
    sessionItems,
    t("empty.sessions", "暂无会话用量记录"),
    {
      value: (item) => compactNumber(item.tokens),
      fullName: (item) => item.umo,
      fullValue: (item) =>
        t("rankDetail", "{tokens} Tokens · {calls} 次调用 · 占比 {share}", {
          tokens: formatNumber(item.tokens),
          calls: formatNumber(item.calls),
          share: formatPercent(item.share),
        }),
    },
  );
}

function renderTotalCard(data) {
  const totals = data?.totals || {};
  if (dom.totalLabel) {
    dom.totalLabel.textContent = t(
      "totalCard.label",
      "{range}总 Tokens",
      { range: rangeLabel() },
    );
  }
  if (dom.totalValue) {
    dom.totalValue.textContent = formatNumber(totals.tokens);
    dom.totalValue.title = formatNumber(totals.tokens);
  }
  if (dom.totalCalls) {
    dom.totalCalls.textContent = t(
      "totalCard.calls",
      "共 {calls} 次调用 · 平均每调用 {avg} Tokens",
      {
        calls: formatNumber(totals.calls),
        avg: formatNumber(totals.avg_tokens_per_call),
      },
    );
  }
  if (dom.totalMeta) {
    const meta = [
      [t("totalCard.avgTtft", "平均首字耗时"), formatDuration(totals.avg_ttft_ms)],
      [t("totalCard.avgDuration", "平均耗时"), formatDuration(totals.avg_duration_ms)],
      [t("totalCard.avgTpm", "平均 TPM"), formatTpm(totals.avg_tpm)],
      [
        t("totalCard.successRate", "成功率"),
        totals.calls ? formatPercent(totals.success_rate) : "—",
      ],
    ];
    dom.totalMeta.replaceChildren(
      ...meta.map(([label, value]) => {
        const row = createElement("div", "meta-row");
        row.appendChild(createElement("span", "meta-label", label));
        row.appendChild(createElement("strong", "meta-value", value));
        return row;
      }),
    );
  }
}

function chartLabels(daily) {
  return (daily || []).map((item) => String(item.date || "").slice(5));
}

function renderCharts(data) {
  const daily = data?.daily || [];
  const labels = chartLabels(daily);
  const primary = getThemeColor("--primary") || "#3c96ca";

  renderAreaChart(dom.areaChart, {
    labels,
    values: daily.map((item) => item.tokens || 0),
    color: primary,
    formatAxis: compactNumber,
    formatValue: (value) => formatNumber(value),
    valueLabel: t("chart.tokens", "Tokens"),
    emptyText: t("empty.chart", "暂无数据"),
    ariaLabel: t("chart.areaLabel", "每日 Token 用量趋势"),
  });

  const series = (data?.trend?.providers || []).map((item, index) => {
    const isOther = item.name === OTHER_SERIES;
    const color = isOther
      ? OTHER_COLOR
      : SERIES_COLORS[index % Math.max(SERIES_COLORS.length - 1, 1)];
    const name = isOther ? t("chart.others", "其他") : item.name;
    return {
      name,
      color,
      data: labels.map((_, dayIndex) => item.data?.[dayIndex] || 0),
    };
  });
  renderStackedChart(dom.stackChart, {
    labels,
    series,
    colors: SERIES_COLORS,
    formatAxis: compactNumber,
    formatValue: (value) => formatNumber(value),
    totalLabel: t("chart.total", "合计"),
    emptyText: t("empty.chart", "暂无数据"),
    ariaLabel: t("chart.stackLabel", "各服务商每日 Token 用量"),
  });
}

function renderTexts() {
  renderHeader();
  if (dom.trendTitle) dom.trendTitle.textContent = t("sections.trend", "Token 趋势");
  if (dom.areaTitle) {
    dom.areaTitle.textContent = t("chart.areaTitle", "每日 Token 用量");
  }
  if (dom.areaNote) {
    dom.areaNote.textContent = t(
      "chart.areaNote",
      "按本地日期汇总输入与输出 Token · {timezone}",
      { timezone: state.data?.timezone || "本地时间" },
    );
  }
  if (dom.providerRankTitle) {
    dom.providerRankTitle.textContent = t("sections.providerRanking", "服务商排名");
  }
  if (dom.modelSectionTitle) {
    dom.modelSectionTitle.textContent = t("sections.modelCalls", "模型调用");
  }
  if (dom.stackTitle) {
    dom.stackTitle.textContent = t("chart.stackTitle", "各服务商每日 Token");
  }
  if (dom.modelRankTitle) {
    dom.modelRankTitle.textContent = t("sections.modelRanking", "模型排名");
  }
  if (dom.sessionRankTitle) {
    dom.sessionRankTitle.textContent = t("sections.sessionRanking", "会话用量排名");
  }
  if (dom.areaMetricLabel) {
    dom.areaMetricLabel.textContent = t("chart.rangeTotal", "区间总 Tokens");
  }
  if (dom.areaMetricValue && state.data) {
    dom.areaMetricValue.textContent = compactNumber(state.data.totals?.tokens || 0);
    dom.areaMetricValue.title = formatNumber(state.data.totals?.tokens || 0);
  }
  if (dom.footer) {
    const all = state.data?.all_time || {};
    if (all.calls) {
      dom.footer.textContent = t(
        "footer.line",
        "统计自 {first} · 共 {tokens} Tokens（{calls} 次调用） · 数据来自 AstrBot provider_stats · 插件 v{version}",
        {
          first: all.first_date || "—",
          tokens: formatNumber(all.tokens),
          calls: formatNumber(all.calls),
          version: state.data?.plugin_version || "1.0.0",
        },
      );
    } else {
      dom.footer.textContent = t(
        "footer.empty",
        "AstrBot 尚未记录 Token 用量，先和机器人聊几句再来查看吧。",
      );
    }
  }
}

function renderAll() {
  const data = state.data;
  if (!data) return;
  dom.content.classList.remove("hidden");
  renderTexts();
  renderOverview(data);
  renderTotalCard(data);
  renderRankings(data);
  renderCharts(data);
}

async function load({ silent = false } = {}) {
  if (!state.bridge) return;
  if (state.loading) {
    state.pendingLoad = true;
    return;
  }
  setLoading(!silent);
  if (!silent) hideError();
  try {
    const data = await state.bridge.apiGet("stats", { days: state.days });
    if (!data || typeof data !== "object") {
      throw new Error(t("errors.badResponse", "统计接口返回了无法识别的数据。"));
    }
    state.data = data;
    state.lastLoadedAt = Date.now();
    hideError();
    renderAll();
  } catch (error) {
    const message =
      (error && error.message) ||
      t("errors.loadFailed", "加载 Token 统计失败，请稍后重试。");
    if (silent && state.data) {
      showError(message);
    } else {
      showError(message);
      dom.content.classList.add("hidden");
    }
  } finally {
    setLoading(false);
    if (state.pendingLoad) {
      state.pendingLoad = false;
      void load({ silent: false });
    }
  }
}

function startAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void load({ silent: true });
  }, REFRESH_INTERVAL_MS);
}

function bindStaticEvents() {
  if (dom.refresh) {
    dom.refresh.addEventListener("click", () => {
      void load({ silent: false });
    });
  }
  if (dom.retry) {
    dom.retry.addEventListener("click", () => {
      void load({ silent: false });
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.data || Date.now() - state.lastLoadedAt > 30_000) {
      void load({ silent: Boolean(state.data) });
    }
  });
  window.addEventListener("beforeunload", () => {
    if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  });
}

function waitForBridge(timeout = 8000) {
  const existing = window.AstrBotPluginView || window.AstrBotPluginPage;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const bridge = window.AstrBotPluginView || window.AstrBotPluginPage;
      if (bridge) {
        window.clearInterval(timer);
        resolve(bridge);
        return;
      }
      if (Date.now() - started >= timeout) {
        window.clearInterval(timer);
        resolve(null);
      }
    }, 50);
  });
}

async function bootstrap() {
  dom.title = $("page-title");
  dom.subtitle = $("page-subtitle");
  dom.updatedAt = $("updated-at");
  dom.refresh = $("refresh");
  dom.error = $("error");
  dom.errorText = $("error-text");
  dom.retry = $("retry");
  dom.loading = $("loading");
  dom.content = $("content");
  dom.overview = $("overview");
  dom.rangeSwitch = $("range-switch");
  dom.trendTitle = $("trend-title");
  dom.areaTitle = $("area-title");
  dom.areaNote = $("area-note");
  dom.areaMetricLabel = $("area-metric-label");
  dom.areaMetricValue = $("area-metric-value");
  dom.areaChart = $("area-chart");
  dom.providerRank = $("provider-rank");
  dom.providerRankTitle = $("provider-rank-title");
  dom.modelSectionTitle = $("model-section-title");
  dom.stackTitle = $("stack-title");
  dom.stackChart = $("stack-chart");
  dom.totalLabel = $("total-label");
  dom.totalValue = $("total-value");
  dom.totalCalls = $("total-calls");
  dom.totalMeta = $("total-meta");
  dom.modelRank = $("model-rank");
  dom.modelRankTitle = $("model-rank-title");
  dom.sessionRank = $("session-rank");
  dom.sessionRankTitle = $("session-rank-title");
  dom.footer = $("footer");

  bindStaticEvents();
  state.bridge = await waitForBridge();
  if (!state.bridge) {
    setLoading(false);
    showError(
      t(
        "errors.bridgeMissing",
        "未检测到 AstrBot 插件视图桥接，请从 AstrBot WebUI 的插件页面打开本视图。",
      ),
    );
    return;
  }

  let context = null;
  try {
    context = await Promise.race([
      state.bridge.ready().catch(() => null),
      new Promise((resolve) => window.setTimeout(() => resolve(null), 5000)),
    ]);
  } catch {
    context = null;
  }
  if (!context) {
    setLoading(false);
    showError(
      t(
        "errors.bridgeMissing",
        "未检测到 AstrBot 插件视图桥接，请从 AstrBot WebUI 的插件页面打开本视图。",
      ),
    );
    return;
  }
  applyContext(context);
  if (typeof state.bridge.onContext === "function") {
    state.bridge.onContext((nextContext) => {
      const previousLocale = state.locale;
      const previousDark = state.isDark;
      applyContext(nextContext);
      if (previousLocale !== state.locale || previousDark !== state.isDark) {
        renderTexts();
        renderRangeSwitch();
        if (state.data) {
          renderOverview(state.data);
          renderTotalCard(state.data);
          renderRankings(state.data);
          renderCharts(state.data);
        }
      }
    });
  }

  renderTexts();
  renderRangeSwitch();
  await load();
  startAutoRefresh();
}

void bootstrap();
