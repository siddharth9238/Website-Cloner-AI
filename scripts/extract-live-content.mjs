import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const targetUrl = process.argv[2] ?? "https://siddharthsingh-main.vercel.app/";
const root = process.cwd();
const url = new URL(targetUrl);
const siteSlug = url.hostname.replace(/[^a-z0-9.-]/gi, "-");
const outFile = path.join(root, "docs", "research", siteSlug, "content-structure.json");
const profileDir = path.join(root, ".tmp", `content-chrome-${process.pid}`);
const port = Number(process.env.CDP_PORT ?? 10222 + Math.floor(Math.random() * 1000));
const chromePath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean).find((candidate) => existsSync(candidate));

if (!chromePath) throw new Error("Chrome or Edge was not found.");

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
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.events.get(message.method) ?? []) listener(message.params);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const listener = (params) => {
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) ?? []).filter((item) => item !== listener));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.events.set(method, [...(this.events.get(method) ?? []), listener]);
    });
  }

  close() {
    this.ws?.close();
  }
}

async function waitForEndpoint(endpoint) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${endpoint}`);
}

async function createPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (response.ok) return response.json();
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((item) => item.json());
  return pages.find((item) => item.type === "page");
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
  return result.result.value;
}

const extractionScript = String.raw`
(() => {
  const clean = (value) => (value || "").replace(/\s+/g, " ").replace(/›\s*/g, "").trim();
  const direct = (root, selector) => root.querySelector(selector);
  const text = (root, selector) => clean(root.querySelector(selector)?.innerText || root.querySelector(selector)?.textContent || "");
  const texts = (root, selector) => [...root.querySelectorAll(selector)].map((node) => clean(node.innerText || node.textContent)).filter(Boolean);
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const pickStyles = (node) => {
    const c = getComputedStyle(node);
    return {
      display: c.display,
      gridTemplateColumns: c.gridTemplateColumns,
      gap: c.gap,
      padding: c.padding,
      margin: c.margin,
      width: c.width,
      height: c.height,
      borderRadius: c.borderRadius,
      border: c.border,
      background: c.background,
      color: c.color,
      fontFamily: c.fontFamily,
      fontSize: c.fontSize,
      fontWeight: c.fontWeight,
      lineHeight: c.lineHeight,
      letterSpacing: c.letterSpacing,
      boxShadow: c.boxShadow,
      transition: c.transition,
      transform: c.transform,
      opacity: c.opacity,
    };
  };

  const nav = {
    brand: text(document, "header a.text-lg"),
    links: texts(document, "header nav a[href^='#']"),
    themeButtons: [...document.querySelectorAll("header button[aria-label]")].map((button) => button.getAttribute("aria-label")),
    mobileButton: document.querySelector("header button[aria-controls]")?.getAttribute("aria-label") || null,
  };

  const hero = {
    eyebrow: text(document, "section:first-of-type .inline-flex span.text-xs"),
    intro: text(document, "section:first-of-type p.font-mono"),
    title: texts(document, "section:first-of-type h1 span:not(.sr-only)").join(""),
    srTitle: text(document, "section:first-of-type h1 .sr-only"),
    subtitle: text(document, "section:first-of-type p.text-lg"),
    description: text(document, "section:first-of-type p.text-sm.text-muted\\/80"),
    actions: [...document.querySelectorAll("section:first-of-type a")].map((link) => ({ text: clean(link.innerText), href: link.href })),
  };

  const about = {
    paragraphs: texts(document, "#about p.text-muted.leading-relaxed"),
    stats: [...document.querySelectorAll("#about .grid.grid-cols-2 .glass")].map((card) => ({ value: text(card, "p:first-child"), label: text(card, "p:last-child") })),
    image: {
      src: document.querySelector("#about img")?.currentSrc || document.querySelector("#about img")?.src || "",
      alt: document.querySelector("#about img")?.alt || "",
    },
  };

  const experience = [...document.querySelectorAll("#experience .space-y-8 > .relative")].map((item) => ({
    title: text(item, "h3"),
    company: text(item, "p.text-accent"),
    dates: text(item, ".flex.flex-col span:first-child"),
    location: text(item, ".flex.flex-col span:nth-child(2)"),
    bullets: texts(item, "ul li"),
    tags: texts(item, ".rounded-full"),
    cardStyles: pickStyles(item.querySelector(".glass")),
  }));

  const projects = [...document.querySelectorAll("#projects .grid > .glass")].map((card) => ({
    title: text(card, "h3"),
    category: text(card, "p.text-accent"),
    description: text(card, "p.text-muted"),
    bullets: texts(card, "ul li"),
    tags: texts(card, ".rounded-full"),
    styles: pickStyles(card),
  }));

  const skills = [...document.querySelectorAll("#skills .grid > .glass")].map((card) => ({
    category: text(card, "h3"),
    items: texts(card, "span"),
    styles: pickStyles(card),
  }));

  const achievementGroups = [...document.querySelectorAll("#achievements .grid > .glass")].map((group) => ({
    title: text(group, "h3"),
    entries: [...group.querySelectorAll(".space-y-3 > div, .space-y-2 > div")].map((entry) => ({
      title: text(entry, "p.text-foreground\\/80, p.font-medium, p:first-child"),
      description: text(entry, "p.text-xs, p.text-sm.text-muted"),
      meta: texts(entry, "span, p.text-muted\\/70"),
      fullText: clean(entry.innerText),
    })),
    styles: pickStyles(group),
  }));

  const contact = {
    eyebrow: text(document, "#contact p.uppercase"),
    heading: text(document, "#contact h2"),
    description: text(document, "#contact p.text-muted"),
    action: { text: text(document, "#contact a.group"), href: document.querySelector("#contact a.group")?.href || "" },
    social: [...document.querySelectorAll("#contact a[aria-label]")].map((link) => ({ label: link.getAttribute("aria-label"), href: link.href })),
  };

  const footer = {
    text: clean(document.querySelector("footer")?.innerText),
    links: [...document.querySelectorAll("footer a")].map((link) => ({ text: clean(link.innerText), href: link.href })),
  };

  const sampleStyles = {
    header: pickStyles(document.querySelector("header")),
    nav: pickStyles(document.querySelector("header nav")),
    section: pickStyles(document.querySelector("#about")),
    sectionHeading: pickStyles(document.querySelector("#about h2")),
    glass: pickStyles(document.querySelector(".glass")),
    cta: pickStyles(document.querySelector(".cta-btn")),
    body: pickStyles(document.body),
  };

  return { nav, hero, about, experience, projects, skills, achievementGroups, contact, footer, sampleStyles };
})()
`;

async function main() {
  await mkdir(path.dirname(outFile), { recursive: true });
  await mkdir(path.dirname(profileDir), { recursive: true });
  await rm(profileDir, { recursive: true, force: true });
  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1100",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  try {
    await waitForEndpoint(`http://127.0.0.1:${port}/json/version`);
    const page = await createPage();
    const client = new CdpClient(page.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    const loaded = client.once("Page.loadEventFired").catch(() => null);
    await client.send("Page.navigate", { url: targetUrl });
    await loaded;
    await delay(1500);
    const data = await evaluate(client, extractionScript);
    await writeFile(outFile, JSON.stringify(data, null, 2));
    client.close();
  } finally {
    chrome.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});