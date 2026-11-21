/**
 * 轻量 SVG 图表：插件视图不能依赖 CDN，也不应把第三方图表库塞进插件包，
 * 因此这里用原生 SVG 实现和 AstrBot 统计页一致的折线面积图与堆叠柱状图。
 *
 * 每个 render 函数都会把清理函数挂在容器上，重复渲染前自动销毁旧的
 * ResizeObserver 和事件监听，避免长时间打开页面时泄漏。
 */

const NS = "http://www.w3.org/2000/svg";
const PAD = { left: 54, right: 14, top: 14, bottom: 30 };
const AXIS_LINES = 4;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function textEl(text, attrs = {}) {
  const node = svgEl("text", attrs);
  node.textContent = String(text);
  return node;
}

function cleanupContainer(container) {
  if (typeof container.__chartCleanup === "function") {
    container.__chartCleanup();
    container.__chartCleanup = null;
  }
  container.replaceChildren();
}

export function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / power;
  let step = 10;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 2.5) step = 2.5;
  else if (normalized <= 5) step = 5;
  return step * power;
}

function xLabelIndices(count, desired = 6) {
  if (count <= 0) return [];
  if (count <= desired) return Array.from({ length: count }, (_, index) => index);
  const indices = [];
  for (let index = 0; index < desired; index += 1) {
    indices.push(Math.round((index * (count - 1)) / (desired - 1)));
  }
  return [...new Set(indices)];
}

function smoothPath(points, minY, maxY) {
  if (!points.length) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = Math.min(maxY, Math.max(minY, p1.y + (p2.y - p0.y) / 6));
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.min(maxY, Math.max(minY, p2.y - (p3.y - p1.y) / 6));
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

function buildTooltip(container) {
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  container.appendChild(tip);
  return tip;
}

function positionTooltip(tip, container, clientX, clientY) {
  const rect = container.getBoundingClientRect();
  const offsetX = clientX - rect.left + 14;
  const offsetY = clientY - rect.top + 12;
  const maxLeft = Math.max(8, rect.width - tip.offsetWidth - 8);
  const maxTop = Math.max(8, rect.height - tip.offsetHeight - 8);
  tip.style.left = `${Math.min(offsetX, maxLeft)}px`;
  tip.style.top = `${Math.min(offsetY, maxTop)}px`;
  tip.hidden = false;
}

function tooltipRow(tip, color, label, valueText) {
  const row = document.createElement("div");
  row.className = "chart-tip-row";
  if (color) {
    const dot = document.createElement("span");
    dot.className = "chart-tip-dot";
    dot.style.background = color;
    row.appendChild(dot);
  }
  const name = document.createElement("span");
  name.className = "chart-tip-name";
  name.textContent = label;
  row.appendChild(name);
  const value = document.createElement("strong");
  value.textContent = valueText;
  row.appendChild(value);
  tip.appendChild(row);
}

function setupResize(container, draw) {
  let frame = 0;
  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}

/**
 * 折线面积图（每日 Token 趋势）。
 *
 * @param {HTMLElement} container 图表容器。
 * @param {object} options 选项：labels、values、color、formatAxis、formatValue、
 *   emptyText、ariaLabel。
 */
export function renderAreaChart(container, options) {
  cleanupContainer(container);
  container.classList.add("chart-root");
  const {
    labels = [],
    values = [],
    color = "#3c96ca",
    formatAxis = (value) => String(value),
    formatValue = (value) => String(value),
    valueLabel = "",
    emptyText = "",
    ariaLabel = "",
  } = options;
  const count = Math.min(labels.length, values.length);
  const tip = buildTooltip(container);
  let cleanupResize = () => {};
  let hoverGroup = null;

  const draw = () => {
    const width = Math.max(280, Math.floor(container.clientWidth || 280));
    const height = Math.max(180, Math.floor(container.clientHeight || 320));
    if (hoverGroup) {
      hoverGroup.remove();
      hoverGroup = null;
    }
    for (const node of container.querySelectorAll("svg")) node.remove();

    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`,
      width: "100%",
      height: "100%",
      role: "img",
      "aria-label": ariaLabel,
      preserveAspectRatio: "none",
    });
    container.appendChild(svg);

    const plotWidth = width - PAD.left - PAD.right;
    const plotHeight = height - PAD.top - PAD.bottom;
    const hasData = values.slice(0, count).some((value) => Number(value) > 0);
    const maxValue = niceMax(Math.max(...values.slice(0, count), 0));
    const yFor = (value) => PAD.top + plotHeight - (value / maxValue) * plotHeight;

    const gradientId = `area-grad-${Math.random().toString(36).slice(2, 9)}`;
    const defs = svgEl("defs");
    const gradient = svgEl("linearGradient", {
      id: gradientId,
      x1: "0",
      y1: "0",
      x2: "0",
      y2: "1",
    });
    gradient.appendChild(
      svgEl("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.24" }),
    );
    gradient.appendChild(
      svgEl("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0.02" }),
    );
    defs.appendChild(gradient);
    svg.appendChild(defs);

    for (let line = 0; line <= AXIS_LINES; line += 1) {
      const ratio = line / AXIS_LINES;
      const y = PAD.top + plotHeight * ratio;
      svg.appendChild(
        svgEl("line", {
          x1: PAD.left,
          y1: y,
          x2: width - PAD.right,
          y2: y,
          class: "chart-grid",
        }),
      );
      const value = maxValue * (1 - ratio);
      if (hasData) {
        const label = textEl(formatAxis(value), {
          x: PAD.left - 10,
          y: y + 4,
          "text-anchor": "end",
          class: "chart-axis-text",
        });
        svg.appendChild(label);
      }
    }

    if (count === 0) {
      svg.appendChild(
        textEl(emptyText, {
          x: PAD.left + plotWidth / 2,
          y: PAD.top + plotHeight / 2,
          "text-anchor": "middle",
          class: "chart-empty-text",
        }),
      );
      return;
    }

    const step = count > 1 ? plotWidth / (count - 1) : 0;
    for (const index of xLabelIndices(count)) {
      svg.appendChild(
        textEl(labels[index], {
          x: count > 1 ? PAD.left + step * index : PAD.left + plotWidth / 2,
          y: height - 8,
          "text-anchor": "middle",
          class: "chart-axis-text",
        }),
      );
    }

    if (!hasData) {
      svg.appendChild(
        textEl(emptyText, {
          x: PAD.left + plotWidth / 2,
          y: PAD.top + plotHeight / 2,
          "text-anchor": "middle",
          class: "chart-empty-text",
        }),
      );
      return;
    }

    const points = values.slice(0, count).map((value, index) => ({
      x: count > 1 ? PAD.left + step * index : PAD.left + plotWidth / 2,
      y: yFor(value),
    }));

    const linePath = smoothPath(points, PAD.top, PAD.top + plotHeight);
    if (count > 1) {
      const areaPath = `${linePath} L ${points[count - 1].x} ${PAD.top + plotHeight} L ${points[0].x} ${PAD.top + plotHeight} Z`;
      svg.appendChild(
        svgEl("path", { d: areaPath, fill: `url(#${gradientId})`, stroke: "none" }),
      );
    }
    svg.appendChild(
      svgEl("path", {
        d: linePath,
        fill: "none",
        stroke: color,
        "stroke-width": "2.2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );

    if (count === 1) {
      svg.appendChild(
        svgEl("circle", { cx: points[0].x, cy: points[0].y, r: 3.4, fill: color }),
      );
    }

    hoverGroup = svgEl("g", { class: "chart-hover" });
    const vertical = svgEl("line", {
      x1: 0,
      y1: PAD.top,
      x2: 0,
      y2: PAD.top + plotHeight,
      class: "chart-hover-line",
    });
    const dot = svgEl("circle", { cx: 0, cy: 0, r: 4, fill: color, class: "chart-hover-dot" });
    hoverGroup.appendChild(vertical);
    hoverGroup.appendChild(dot);
    hoverGroup.style.opacity = "0";
    svg.appendChild(hoverGroup);

    const overlay = svgEl("rect", {
      x: PAD.left,
      y: PAD.top,
      width: plotWidth,
      height: plotHeight,
      fill: "transparent",
      class: "chart-overlay",
    });
    svg.appendChild(overlay);

    let activeIndex = -1;
    const hide = () => {
      hoverGroup.style.opacity = "0";
      tip.hidden = true;
      activeIndex = -1;
    };
    const show = (index, event) => {
      if (index === activeIndex && !tip.hidden) return;
      activeIndex = index;
      const point = points[index];
      hoverGroup.style.opacity = "1";
      vertical.setAttribute("x1", point.x);
      vertical.setAttribute("x2", point.x);
      dot.setAttribute("cx", point.x);
      dot.setAttribute("cy", point.y);
      tip.replaceChildren();
      const title = document.createElement("div");
      title.className = "chart-tip-title";
      title.textContent = labels[index];
      tip.appendChild(title);
      tooltipRow(tip, color, valueLabel, formatValue(values[index]));
      positionTooltip(tip, container, event.clientX, event.clientY);
    };

    overlay.addEventListener("pointermove", (event) => {
      const rect = svg.getBoundingClientRect();
      const viewX = ((event.clientX - rect.left) / rect.width) * width;
      const ratio = count > 1 ? (viewX - PAD.left) / plotWidth : 0.5;
      const index = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
      show(index, event);
    });
    overlay.addEventListener("pointerleave", hide);
    overlay.addEventListener("pointerdown", (event) => {
      const rect = svg.getBoundingClientRect();
      const viewX = ((event.clientX - rect.left) / rect.width) * width;
      const ratio = count > 1 ? (viewX - PAD.left) / plotWidth : 0.5;
      const index = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
      show(index, event);
    });
  };

  draw();
  cleanupResize = setupResize(container, draw);
  container.__chartCleanup = () => {
    cleanupResize();
    container.__chartCleanup = null;
  };
}

/**
 * 堆叠柱状图（各服务商每日 Token）。
 *
 * @param {HTMLElement} container 图表容器。
 * @param {object} options 选项：labels、series、colors、formatAxis、formatValue、
 *   totalLabel、emptyText、ariaLabel。
 */
export function renderStackedChart(container, options) {
  cleanupContainer(container);
  container.classList.add("chart-root");
  const {
    labels = [],
    series = [],
    colors = [],
    formatAxis = (value) => String(value),
    formatValue = (value) => String(value),
    totalLabel = "",
    emptyText = "",
    ariaLabel = "",
  } = options;
  const count = labels.length;
  const tip = buildTooltip(container);
  let cleanupResize = () => {};
  let hoverGroup = null;

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.hidden = !series.length;
  series.forEach((item, index) => {
    const entry = document.createElement("span");
    entry.className = "chart-legend-item";
    const dot = document.createElement("span");
    dot.className = "chart-legend-dot";
    dot.style.background = item.color || colors[index % Math.max(colors.length, 1)] || "#3c96ca";
    entry.appendChild(dot);
    const name = document.createElement("span");
    name.textContent = item.name;
    entry.appendChild(name);
    legend.appendChild(entry);
  });
  container.appendChild(legend);

  const draw = () => {
    const width = Math.max(280, Math.floor(container.clientWidth || 280));
    const height = Math.max(220, Math.floor(container.clientHeight || 420));
    if (hoverGroup) {
      hoverGroup.remove();
      hoverGroup = null;
    }
    for (const node of container.querySelectorAll("svg")) node.remove();

    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`,
      width: "100%",
      height: "100%",
      role: "img",
      "aria-label": ariaLabel,
      preserveAspectRatio: "none",
    });
    container.appendChild(svg);

    const plotWidth = width - PAD.left - PAD.right;
    const plotHeight = height - PAD.top - PAD.bottom;
    const totals = labels.map((_, index) =>
      series.reduce((sum, item) => sum + (item.data[index] || 0), 0),
    );
    const hasData = totals.some((value) => Number(value) > 0);
    const maxValue = niceMax(Math.max(...totals, 0));
    const yFor = (value) => PAD.top + plotHeight - (value / maxValue) * plotHeight;

    for (let line = 0; line <= AXIS_LINES; line += 1) {
      const ratio = line / AXIS_LINES;
      const y = PAD.top + plotHeight * ratio;
      svg.appendChild(
        svgEl("line", {
          x1: PAD.left,
          y1: y,
          x2: width - PAD.right,
          y2: y,
          class: "chart-grid",
        }),
      );
      if (hasData) {
        svg.appendChild(
          textEl(formatAxis(maxValue * (1 - ratio)), {
            x: PAD.left - 10,
            y: y + 4,
            "text-anchor": "end",
            class: "chart-axis-text",
          }),
        );
      }
    }

    if (count === 0) {
      svg.appendChild(
        textEl(emptyText, {
          x: PAD.left + plotWidth / 2,
          y: PAD.top + plotHeight / 2,
          "text-anchor": "middle",
          class: "chart-empty-text",
        }),
      );
      return;
    }

    const step = plotWidth / count;
    for (const index of xLabelIndices(count)) {
      svg.appendChild(
        textEl(labels[index], {
          x: PAD.left + step * (index + 0.5),
          y: height - 8,
          "text-anchor": "middle",
          class: "chart-axis-text",
        }),
      );
    }

    if (!hasData) {
      svg.appendChild(
        textEl(emptyText, {
          x: PAD.left + plotWidth / 2,
          y: PAD.top + plotHeight / 2,
          "text-anchor": "middle",
          class: "chart-empty-text",
        }),
      );
      return;
    }

    const barWidth = Math.max(1.2, step * 0.58);
    const barsGroup = svgEl("g");
    for (let index = 0; index < count; index += 1) {
      let base = PAD.top + plotHeight;
      const x = PAD.left + step * (index + 0.5) - barWidth / 2;
      series.forEach((item, seriesIndex) => {
        const value = item.data[index] || 0;
        if (value <= 0) return;
        const barHeight = (value / maxValue) * plotHeight;
        const color = item.color || colors[seriesIndex % Math.max(colors.length, 1)] || "#3c96ca";
        barsGroup.appendChild(
          svgEl("rect", {
            x,
            y: base - barHeight,
            width: barWidth,
            height: Math.max(barHeight, 0.6),
            fill: color,
            rx: barWidth > 4 ? 1.5 : 0,
            class: "chart-bar",
          }),
        );
        base -= barHeight;
      });
    }
    svg.appendChild(barsGroup);

    hoverGroup = svgEl("g", { class: "chart-hover" });
    const highlight = svgEl("rect", {
      x: 0,
      y: PAD.top,
      width: Math.max(step, 2),
      height: plotHeight,
      fill: "transparent",
      class: "chart-hover-band",
    });
    hoverGroup.appendChild(highlight);
    hoverGroup.style.opacity = "0";
    svg.appendChild(hoverGroup);

    const overlay = svgEl("rect", {
      x: PAD.left,
      y: PAD.top,
      width: plotWidth,
      height: plotHeight,
      fill: "transparent",
      class: "chart-overlay",
    });
    svg.appendChild(overlay);

    let activeIndex = -1;
    const show = (index, event) => {
      if (index === activeIndex && !tip.hidden) return;
      activeIndex = index;
      hoverGroup.style.opacity = "1";
      highlight.setAttribute("x", PAD.left + step * index);
      tip.replaceChildren();
      const title = document.createElement("div");
      title.className = "chart-tip-title";
      title.textContent = labels[index];
      tip.appendChild(title);
      const rows = series
        .map((item, seriesIndex) => ({
          item,
          seriesIndex,
          value: item.data[index] || 0,
        }))
        .filter((entry) => entry.value > 0)
        .sort((left, right) => right.value - left.value)
        .slice(0, 8);
      for (const entry of rows) {
        const color =
          entry.item.color ||
          colors[entry.seriesIndex % Math.max(colors.length, 1)] ||
          "#3c96ca";
        tooltipRow(tip, color, entry.item.name, formatValue(entry.value));
      }
      const totalRow = document.createElement("div");
      totalRow.className = "chart-tip-total";
      totalRow.textContent = `${totalLabel} ${formatValue(totals[index])}`;
      tip.appendChild(totalRow);
      positionTooltip(tip, container, event.clientX, event.clientY);
    };
    const hide = () => {
      hoverGroup.style.opacity = "0";
      tip.hidden = true;
      activeIndex = -1;
    };
    overlay.addEventListener("pointermove", (event) => {
      const rect = svg.getBoundingClientRect();
      const viewX = ((event.clientX - rect.left) / rect.width) * width;
      const index = Math.min(
        count - 1,
        Math.max(0, Math.floor((viewX - PAD.left) / step)),
      );
      show(index, event);
    });
    overlay.addEventListener("pointerleave", hide);
    overlay.addEventListener("pointerdown", (event) => {
      const rect = svg.getBoundingClientRect();
      const viewX = ((event.clientX - rect.left) / rect.width) * width;
      const index = Math.min(
        count - 1,
        Math.max(0, Math.floor((viewX - PAD.left) / step)),
      );
      show(index, event);
    });
  };

  draw();
  cleanupResize = setupResize(container, draw);
  container.__chartCleanup = () => {
    cleanupResize();
    container.__chartCleanup = null;
  };
}
