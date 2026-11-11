/**
 * 渲染门禁 / 真机探针共用的小工具（RFC 0013 §11 的基建）。
 *
 * 三件事：把入口 TS 及其相对依赖编成「URL → JS 源码」的图、用极小静态服务发出去、
 * 用一个够用的 CDP 客户端驱动浏览器。
 *
 * **为什么不用 Vite**：本人 `apps/desktop` 的 Vite dev server 会占住端口却不回任何 HTTP
 * 响应（`curl` 8 s 超时 = `000`），门禁一旦依赖它就会永久挂住；而仓库用的是 TypeScript 7
 * （原生实现），`require("typescript")` 只有 `lib/version.cjs`，没有 `transpileModule`
 * 这类 JS API。因此只能 `tsc` CLI + 临时 tsconfig，再把产物逐文件发出去。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { connect as netConnect } from "node:net";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 够用的 CDP 客户端：只做 `send` / `eval` / `close`。 */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 60000);
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "求值失败",
      );
    }
    return res.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 打开一个 CDP socket；没有超时的 open 等待会在端点给了但连不上时静默挂死。 */
export async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP socket 15s 未打开：${wsUrl}`)), 15000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        res();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (ev) => {
        clearTimeout(timer);
        rej(new Error(`CDP socket 出错：${ev?.message ?? wsUrl}`));
      },
      { once: true },
    );
  });
  return new Cdp(ws);
}

/** 轮询一个表达式直到为真。 */
export async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdp.eval(expression)) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${label}）`);
    await sleep(200);
  }
}

/** 端口上有没有东西在监听（不管它回不回话）。 */
export function portInUse(port) {
  return new Promise((resolvePort) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolvePort(value);
    };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function toUrlPath(file) {
  return file.split(sep).join("/");
}

/**
 * 把入口 TS 及其相对依赖编成「URL → JS 源码」的图（键是相对 `root` 的 URL 路径）。
 *
 * `noEmitOnError: false` 是**故意的**：夹具脚本里一处类型小错不该让门禁完全没产物，
 * 真正的错会在浏览器里立刻炸出来，比"tsc 一行报错、什么都没跑"更容易定位。
 */
export async function compileGraph(entry, { root, desktop }) {
  const tscBin = join(desktop, "node_modules/typescript/bin/tsc");
  if (!existsSync(tscBin)) throw new Error(`找不到 tsc：${tscBin}`);
  const outDir = mkdtempSync(join(tmpdir(), "hp-render-build-"));

  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      types: [],
      strict: true,
      skipLibCheck: true,
      noEmitOnError: false,
      declaration: false,
      sourceMap: false,
      rootDir: root,
      outDir,
    },
    files: [entry],
  };
  const configPath = join(outDir, "tsconfig.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  const build = spawn(process.execPath, [tscBin, "-p", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  build.stdout.on("data", (d) => (output += d.toString()));
  build.stderr.on("data", (d) => (output += d.toString()));
  const code = await new Promise((done) => build.on("exit", (c) => done(c)));

  const emitted = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js") && full !== configPath) emitted.push(full);
    }
  };
  walk(outDir);
  if (code !== 0 && emitted.length === 0) throw new Error(`tsc 未产出任何文件：\n${output}`);

  const modules = new Map();
  for (const file of emitted) {
    const url = toUrlPath(relative(outDir, file));
    // tsc 保留无扩展名的相对说明符，浏览器必须拿到完整 URL。
    // 带 `?` / `#` 的是 Vite 的查询式导入（如 `?raw`），补 `.js` 会变成另一个 URL，
    // 交给下面 `?raw` 路由原样处理。
    const body = readFileSync(file, "utf8").replace(
      /(\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']*?)(\2)/g,
      (match, head, quote, specifier, close) =>
        specifier.endsWith(".js") || /[?#]/.test(specifier)
          ? match
          : `${head}${quote}${specifier}.js${close}`,
    );
    modules.set(url, body);
  }
  const entryId = toUrlPath(relative(root, entry).replace(/\.tsx?$/, ".js"));
  if (!modules.has(entryId)) throw new Error(`入口模块未编出：${entryId}`);
  return { entryId, modules, outDir, output, desktop, root };
}

/**
 * 只发内存里那几张 JS、一张 HTML 与应用样式表的静态服务。
 *
 * - `styles.css` 必须发**应用自己的**：`dom` 后端的定位来自 `.iv-image` 的 `left/top:50%`，
 *   少了它图像会跑到左上角，比出来的 SSIM 毫无意义。
 * - `cors` 用于"在别的页面里 `import()` 这个模块图"（真机探针把夹具注进打包 app 的页面里，
 *   不导航、不另一个进程，量到的才是同一个 WebView2 的 GPU 路径）。
 */
export async function startStaticServer({ port, graph, html, cors = false, files = null }) {
  if (await portInUse(port)) {
    throw new Error(`端口 ${port} 已被占用。先结束该进程，或用 --port=<其它端口>。`);
  }
  const stylesPath = join(graph.desktop, "src/app_ui/shared/styles.css");

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    // WebView2 的页面 origin 是 `http://tauri.localhost`，向 127.0.0.1 取模块属于
    // 「公网页面访问私有网络」，Chrome 会先发 preflight 并要求显式允许私有网络，
    // 只给 `allow-origin` 会得到 Failed to fetch。
    const headers = cors
      ? {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-allow-private-network": "true",
          "timing-allow-origin": "*",
        }
      : {};
    if (cors && req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (path === "/" || path.endsWith(".html")) {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (path === "/styles.css") {
      res.writeHead(200, { ...headers, "content-type": "text/css; charset=utf-8" });
      res.end(readFileSync(stylesPath));
      return;
    }
    // Vite 的 `?raw` 导入在打包里由 Vite 处理；这里用同一套 URL 形状补一份等价模块，
    // 否则 tsc 编出来的 `import shader from "./x.wgsl?raw"` 会 404，整张图都加载失败。
    if (path.startsWith("/m/") && new URL(req.url ?? "/", "http://127.0.0.1").searchParams.has("raw")) {
      const file = join(graph.root, path.slice(3));
      try {
        const text = readFileSync(file, "utf8");
        res.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
        res.end(`export default ${JSON.stringify(text)};`);
        return;
      } catch {
        res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
        res.end("raw asset not found");
        return;
      }
    }
    // 真机探针要喂**真实**图片（用户的资源库），用 /f/<key> 原样流出。
    const fileKey = /^\/f\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
    if (fileKey && files && files.has(fileKey)) {
      const file = files.get(fileKey);
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      const type =
        ext === ".png" ? "image/png"
        : ext === ".webp" ? "image/webp"
        : ext === ".avif" ? "image/avif"
        : ext === ".gif" ? "image/gif"
        : ext === ".bmp" ? "image/bmp"
        : "image/jpeg";
      res.writeHead(200, { ...headers, "content-type": type, "cache-control": "no-store" });
      res.end(readFileSync(file));
      return;
    }
    const name = /^\/m\/([\w./-]+\.js)$/.exec(path)?.[1];
    const body = name ? graph.modules.get(name) : undefined;
    if (!body) {
      res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
    res.end(body);
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", done);
  });
  return {
    server,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
