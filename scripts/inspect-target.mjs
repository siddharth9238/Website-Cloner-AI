import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const targetUrl = process.argv[2] ?? "https://siddharthsingh-main.vercel.app/";
const url = new URL(targetUrl);
const siteSlug = url.hostname.replace(/[^a-z0-9.-]/gi, "-");
const root = process.cwd();
const researchDir = path.join(root, "docs", "research", siteSlug);
const componentsDir = path.join(root, "docs", "research", "components");
const referenceDir = path.join(root, "docs", "design-references", siteSlug);
const profileDir = path.join(root, ".tmp", `chrome-profile-${process.pid}`);
const port = Number(process.env.CDP_PORT ?? 9222 + Math.floor(Math.random() * 1000));

const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));

if (!chromePath) {
  throw new Error("Chrome or Edge was not found. Set CHROME_PATH to a Chromium executable.");
}

class CdpClient {
  constructor(socketUrl) {
    this.socketUrl = socketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.socketUrl);
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const listeners = this.events.get(message.method) ?? [];
    for (const listener of listeners) {
      listener(message.params);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (params) => {
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const listeners = this.events.get(method) ?? [];
        this.events.set(
          method,
          listeners.filter((item) => item !== listener),
        );
      };
      this.events.set(method, [...(this.events.get(method) ?? []), listener]);
    });
  }

  close() {
    this.ws?.close();
  }
}

async function waitForEndpoint(endpoint, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return response;
    } catch {
      // Chrome is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${endpoint}`);
}

async function createPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
  });
  if (response.ok) return response.json();

  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((item) =>
    item.json(),
  );
  const page = pages.find((item) => item.type === "page");
  if (!page) throw new Error("No Chrome page target was available.");
  return page;
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
  }
  return result.result.value;
}

async function navigate(client, href) {
  const loaded = client.once("Page.loadEventFired", 30000).catch(() => null);
  await client.send("Page.navigate", { url: href });
  await loaded;
  await waitForReadyState(client);
  await delay(1200);
}

async function waitForReadyState(client) {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const state = await evaluate(client, "document.readyState");
    if (state === "complete") return;
    await delay(200);
  }
}

async function setViewport(client, viewport) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: viewport.mobile,
  });
}

async function captureFullPage(client, filePath) {
  const metrics = await client.send("Page.getLayoutMetrics");
  const contentSize = metrics.cssContentSize ?? metrics.contentSize;
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(contentSize.width),
      height: Math.ceil(contentSize.height),
      scale: 1,
    },
  });
  await writeFile(filePath, Buffer.from(screenshot.data, "base64"));
}

async function captureClip(client, filePath, rect) {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
    clip: {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height)),
      scale: 1,
    },
  });
  await writeFile(filePath, Buffer.from(screenshot.data, "base64"));
}

function jsExtractionScript() {
  return String.raw`
(() => {
  const cssProps = [
    "fontSize", "fontWeight", "fontFamily", "lineHeight", "letterSpacing", "color",
    "textTransform", "textDecoration", "backgroundColor", "background", "backgroundImage",
    "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
    "width", "height", "maxWidth", "minWidth", "maxHeight", "minHeight",
    "display", "flexDirection", "justifyContent", "alignItems", "gap",
    "gridTemplateColumns", "gridTemplateRows",
    "borderRadius", "border", "borderTop", "borderBottom", "borderLeft", "borderRight",
    "boxShadow", "overflow", "overflowX", "overflowY",
    "position", "top", "right", "bottom", "left", "zIndex",
    "opacity", "transform", "transition", "animation", "cursor",
    "objectFit", "objectPosition", "mixBlendMode", "filter", "backdropFilter",
    "whiteSpace", "textOverflow", "WebkitLineClamp"
  ];

  function styleOf(element) {
    const computed = getComputedStyle(element);
    const styles = {};
    for (const prop of cssProps) {
      const value = computed[prop];
      if (
        value &&
        value !== "none" &&
        value !== "normal" &&
        value !== "auto" &&
        value !== "0px" &&
        value !== "rgba(0, 0, 0, 0)"
      ) {
        styles[prop] = value;
      }
    }
    return styles;
  }

  function selectorFor(element) {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      let part = current.tagName.toLowerCase();
      const classNames = [...current.classList].filter(Boolean).slice(0, 3);
      if (classNames.length) part += "." + classNames.map((item) => CSS.escape(item)).join(".");
      const parent = current.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 5) break;
    }
    return parts.join(" > ");
  }

  function textOf(element, limit = 500) {
    return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + scrollX),
      y: Math.round(rect.top + scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
    };
  }

  function pushCount(map, value) {
    if (!value || value === "rgba(0, 0, 0, 0)" || value === "transparent") return;
    map[value] = (map[value] || 0) + 1;
  }

  const allElements = [...document.querySelectorAll("*")];
  const colorCounts = {};
  const typographyCounts = {};
  const spacingCounts = {};
  const radiusCounts = {};
  const shadowCounts = {};

  for (const element of allElements) {
    const computed = getComputedStyle(element);
    pushCount(colorCounts, computed.color);
    pushCount(colorCounts, computed.backgroundColor);
    pushCount(colorCounts, computed.borderColor);
    pushCount(colorCounts, computed.fill);
    pushCount(colorCounts, computed.stroke);
    pushCount(typographyCounts, [computed.fontFamily, computed.fontSize, computed.fontWeight, computed.lineHeight, computed.letterSpacing].join(" | "));
    pushCount(spacingCounts, computed.padding);
    pushCount(spacingCounts, computed.margin);
    pushCount(radiusCounts, computed.borderRadius);
    pushCount(shadowCounts, computed.boxShadow);
  }

  function topEntries(map, count = 40) {
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([value, uses]) => ({ value, uses }));
  }

  const sectionCandidates = [
    ...document.querySelectorAll("header, main > section, main > div, section, footer"),
  ];
  const sections = sectionCandidates
    .filter((element, index, list) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) return false;
      return list.findIndex((candidate) => candidate === element) === index;
    })
    .map((element, index) => ({
      index,
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: [...element.classList].slice(0, 12),
      selector: selectorFor(element),
      text: textOf(element, 900),
      rect: rectOf(element),
      styles: styleOf(element),
      childCount: element.children.length,
      headings: [...element.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((heading) => ({
        tag: heading.tagName.toLowerCase(),
        text: textOf(heading, 180),
        styles: styleOf(heading),
      })),
      images: [...element.querySelectorAll("img")].map((img) => ({
        src: img.currentSrc || img.src,
        alt: img.alt || "",
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        rect: rectOf(img),
        styles: styleOf(img),
      })),
    }));

  const links = [...document.querySelectorAll("a")].map((item) => ({
    text: textOf(item, 120),
    href: item.href,
    ariaLabel: item.getAttribute("aria-label"),
    selector: selectorFor(item),
    rect: rectOf(item),
    styles: styleOf(item),
  }));

  const buttons = [...document.querySelectorAll("button, [role='button'], [role='tab']")].map((item) => ({
    text: textOf(item, 120),
    ariaLabel: item.getAttribute("aria-label"),
    selector: selectorFor(item),
    rect: rectOf(item),
    styles: styleOf(item),
  }));

  const images = [...document.querySelectorAll("img")].map((img) => ({
    src: img.currentSrc || img.src,
    alt: img.alt || "",
    width: img.naturalWidth,
    height: img.naturalHeight,
    loading: img.loading,
    parentClasses: img.parentElement?.className?.toString() || "",
    siblingImages: img.parentElement ? img.parentElement.querySelectorAll("img").length : 0,
    position: getComputedStyle(img).position,
    zIndex: getComputedStyle(img).zIndex,
    selector: selectorFor(img),
  }));

  const videos = [...document.querySelectorAll("video")].map((video) => ({
    src: video.currentSrc || video.src || video.querySelector("source")?.src || "",
    poster: video.poster || "",
    autoplay: video.autoplay,
    loop: video.loop,
    muted: video.muted,
    playsInline: video.playsInline,
    selector: selectorFor(video),
  }));

  const backgroundImages = allElements
    .map((element) => ({
      selector: selectorFor(element),
      backgroundImage: getComputedStyle(element).backgroundImage,
      rect: rectOf(element),
    }))
    .filter((item) => item.backgroundImage && item.backgroundImage !== "none");

  const svgs = [...document.querySelectorAll("svg")].map((svg, index) => ({
    index,
    selector: selectorFor(svg),
    width: svg.getAttribute("width"),
    height: svg.getAttribute("height"),
    viewBox: svg.getAttribute("viewBox"),
    ariaLabel: svg.getAttribute("aria-label"),
    outerHTML: svg.outerHTML,
    parentText: textOf(svg.parentElement || svg, 120),
    styles: styleOf(svg),
  }));

  let fontFaces = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules || []) {
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          fontFaces.push(rule.cssText);
        }
      }
    } catch {
      // Cross-origin stylesheet.
    }
  }

  const scripts = [...document.scripts].map((script) => script.src).filter(Boolean);
  const stylesheets = [...document.querySelectorAll("link[rel='stylesheet']")].map((link) => link.href);

  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang,
    bodyText: textOf(document.body, 6000),
    meta: [...document.querySelectorAll("meta")].map((meta) => ({
      name: meta.getAttribute("name"),
      property: meta.getAttribute("property"),
      content: meta.getAttribute("content"),
    })),
    links: [...document.querySelectorAll("link")].map((link) => ({
      rel: link.rel,
      href: link.href,
      type: link.type,
      sizes: link.sizes?.toString() || "",
    })),
    scripts,
    stylesheets,
    hasNextData: Boolean(document.querySelector("#__NEXT_DATA__")),
    rootClasses: document.documentElement.className,
    bodyClasses: document.body.className,
    colorPalette: topEntries(colorCounts, 60),
    typography: topEntries(typographyCounts, 60),
    spacing: topEntries(spacingCounts, 60),
    radii: topEntries(radiusCounts, 30),
    shadows: topEntries(shadowCounts, 20),
    fontFamilies: [...new Set(allElements.slice(0, 300).map((el) => getComputedStyle(el).fontFamily))],
    fontFaces,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    },
    globalStyles: {
      html: styleOf(document.documentElement),
      body: styleOf(document.body),
      main: document.querySelector("main") ? styleOf(document.querySelector("main")) : null,
    },
    sections,
    links,
    buttons,
    images,
    videos,
    backgroundImages,
    svgs,
    fixedOrSticky: allElements
      .filter((element) => {
        const position = getComputedStyle(element).position;
        return position === "fixed" || position === "sticky";
      })
      .map((element) => ({
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        text: textOf(element, 240),
        rect: rectOf(element),
        styles: styleOf(element),
      })),
    animatedElements: allElements
      .filter((element) => {
        const computed = getComputedStyle(element);
        return computed.transitionDuration !== "0s" || computed.animationName !== "none";
      })
      .slice(0, 120)
      .map((element) => ({
        selector: selectorFor(element),
        text: textOf(element, 140),
        rect: rectOf(element),
        styles: styleOf(element),
      })),
  };
})()
`;
}

function jsBehaviorScript() {
  return String.raw`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const props = ["backgroundColor", "color", "boxShadow", "backdropFilter", "borderRadius", "height", "opacity", "transform", "transition", "position", "top"];
  const stylePick = (element) => {
    if (!element) return null;
    const computed = getComputedStyle(element);
    return Object.fromEntries(props.map((prop) => [prop, computed[prop]]));
  };
  const textOf = (element, limit = 160) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const selectorFor = (element) => {
    if (!element) return null;
    if (element.id) return "#" + CSS.escape(element.id);
    const names = [...element.classList].slice(0, 3).map((name) => "." + CSS.escape(name)).join("");
    return element.tagName.toLowerCase() + names;
  };
  const header = document.querySelector("header, nav");
  window.scrollTo(0, 0);
  await sleep(300);
  const headerAtTop = stylePick(header);
  const scrollSamples = [];
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  for (const ratio of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    window.scrollTo(0, Math.round(maxScroll * ratio));
    await sleep(450);
    const center = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    const fixedOrSticky = [...document.querySelectorAll("*")]
      .filter((element) => {
        const position = getComputedStyle(element).position;
        return position === "fixed" || position === "sticky";
      })
      .slice(0, 20)
      .map((element) => ({
        selector: selectorFor(element),
        text: textOf(element, 120),
        style: stylePick(element),
      }));
    scrollSamples.push({
      ratio,
      scrollY,
      centerText: textOf(center, 180),
      header: stylePick(header),
      fixedOrSticky,
    });
  }
  window.scrollTo(0, 100);
  await sleep(300);
  const headerAfterScroll = stylePick(header);

  const clickTargets = [...document.querySelectorAll("button, [role='button'], [role='tab'], a[href^='#']")].slice(0, 30);
  const clickResults = [];
  for (const target of clickTargets) {
    const beforeText = textOf(document.body, 1000);
    const beforeUrl = location.href;
    target.click();
    await sleep(500);
    clickResults.push({
      selector: selectorFor(target),
      text: textOf(target, 120),
      beforeUrl,
      afterUrl: location.href,
      textChanged: beforeText !== textOf(document.body, 1000),
      activeElement: selectorFor(document.activeElement),
      bodyDeltaSample: textOf(document.body, 1000),
    });
  }

  const hoverTargets = [...document.querySelectorAll("a, button, [role='button'], article, .card")].slice(0, 40).map((element) => ({
    selector: selectorFor(element),
    text: textOf(element, 120),
    style: stylePick(element),
  }));

  return {
    maxScroll,
    headerSelector: selectorFor(header),
    headerAtTop,
    headerAfterScroll,
    scrollSamples,
    clickResults,
    hoverTargets,
    rootClasses: document.documentElement.className,
    bodyClasses: document.body.className,
    smoothScrollSignals: {
      htmlScrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      bodyScrollBehavior: getComputedStyle(document.body).scrollBehavior,
      hasLenisClass: document.documentElement.classList.contains("lenis") || document.body.classList.contains("lenis"),
      hasLocomotiveClass: Boolean(document.querySelector(".locomotive-scroll, [data-scroll-container]")),
      scrollSnapType: getComputedStyle(document.documentElement).scrollSnapType || getComputedStyle(document.body).scrollSnapType,
    },
  };
})()
`;
}

function shortName(input, fallback) {
  if (!input) return fallback;
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

async function main() {
  await mkdir(researchDir, { recursive: true });
  await mkdir(componentsDir, { recursive: true });
  await mkdir(referenceDir, { recursive: true });
  await mkdir(path.dirname(profileDir), { recursive: true });
  await rm(profileDir, { recursive: true, force: true });

  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1200",
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForEndpoint(`http://127.0.0.1:${port}/json/version`);
    const pageInfo = await createPage();
    const client = new CdpClient(pageInfo.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Network.enable");
    await client.send("DOM.enable");

    const viewports = [
      { name: "desktop", width: 1440, height: 1100, mobile: false },
      { name: "tablet", width: 768, height: 1024, mobile: false },
      { name: "mobile", width: 390, height: 844, mobile: true },
    ];

    const captures = [];
    for (const viewport of viewports) {
      await setViewport(client, viewport);
      await navigate(client, targetUrl);
      await evaluate(client, "window.scrollTo(0, 0)");
      const screenshotPath = path.join(referenceDir, `${viewport.name}-full.png`);
      await captureFullPage(client, screenshotPath);
      const extraction = await evaluate(client, jsExtractionScript());
      const behavior = await evaluate(client, jsBehaviorScript(), true);
      const jsonPath = path.join(researchDir, `${viewport.name}-inspection.json`);
      await writeFile(jsonPath, JSON.stringify({ viewport, extraction, behavior }, null, 2));
      captures.push({ viewport, screenshotPath, jsonPath, extraction, behavior });
    }

    const desktop = captures.find((capture) => capture.viewport.name === "desktop");
    await setViewport(client, desktop.viewport);
    await navigate(client, targetUrl);
    const sectionScreens = [];
    for (const section of desktop.extraction.sections.slice(0, 12)) {
      const title = section.headings[0]?.text || section.id || section.classes.join(" ") || `${section.tag}-${section.index}`;
      const name = `${String(section.index + 1).padStart(2, "0")}-${shortName(title, section.tag)}`;
      const filePath = path.join(referenceDir, `${name}.png`);
      await captureClip(client, filePath, {
        x: 0,
        y: Math.max(0, section.rect.y - 24),
        width: Math.max(390, Math.min(desktop.extraction.viewport.scrollWidth, 1440)),
        height: Math.min(Math.max(section.rect.height + 48, 220), 1400),
      });
      sectionScreens.push({
        index: section.index,
        name,
        selector: section.selector,
        screenshotPath: path.relative(root, filePath),
      });
    }

    const merged = {
      targetUrl,
      siteSlug,
      generatedAt: new Date().toISOString(),
      captures: captures.map((capture) => ({
        viewport: capture.viewport,
        screenshotPath: path.relative(root, capture.screenshotPath),
        jsonPath: path.relative(root, capture.jsonPath),
      })),
      sectionScreens,
      desktop: desktop.extraction,
      desktopBehavior: desktop.behavior,
      tablet: captures.find((capture) => capture.viewport.name === "tablet").extraction,
      mobile: captures.find((capture) => capture.viewport.name === "mobile").extraction,
    };

    await writeFile(path.join(researchDir, "inspection-summary.json"), JSON.stringify(merged, null, 2));
    const assetMap = collectAssets(merged);
    await writeFile(path.join(researchDir, "asset-map.json"), JSON.stringify(assetMap, null, 2));
    client.close();
  } finally {
    chrome.kill();
  }
}

function collectAssets(summary) {
  const assets = new Map();
  const add = (rawUrl, kind, context = "") => {
    if (!rawUrl) return;
    const matches = String(rawUrl).match(/https?:\/\/[^")'\s]+/g) ?? [rawUrl];
    for (const match of matches) {
      try {
        const assetUrl = new URL(match, targetUrl);
        if (!["http:", "https:"].includes(assetUrl.protocol)) continue;
        const cleanUrl = assetUrl.href;
        if (!assets.has(cleanUrl)) {
          const ext = path.extname(assetUrl.pathname).replace(/[^a-z0-9.]/gi, "") || "";
          const hash = createHash("sha1").update(cleanUrl).digest("hex").slice(0, 8);
          const basename = shortName(path.basename(assetUrl.pathname, ext), kind);
          assets.set(cleanUrl, {
            url: cleanUrl,
            kind,
            context,
            outputName: `${basename}-${hash}${ext || ".bin"}`,
          });
        }
      } catch {
        // Ignore malformed asset values.
      }
    }
  };

  for (const extraction of [summary.desktop, summary.tablet, summary.mobile]) {
    for (const image of extraction.images ?? []) add(image.src, "image", image.alt || image.selector);
    for (const video of extraction.videos ?? []) {
      add(video.src, "video", video.selector);
      add(video.poster, "image", `${video.selector} poster`);
    }
    for (const background of extraction.backgroundImages ?? []) {
      add(background.backgroundImage, "background", background.selector);
    }
    for (const link of extraction.links ?? []) {
      if (/icon|manifest|apple-touch-icon/i.test(link.rel || "")) {
        add(link.href, "seo", link.rel);
      }
    }
    for (const fontFace of extraction.fontFaces ?? []) add(fontFace, "font", "font-face");
  }

  return [...assets.values()];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
