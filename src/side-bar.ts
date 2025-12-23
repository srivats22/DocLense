import * as vscode from "vscode";
import {
  findPackageJsonFiles,
  readDependencies,
  getDocumentationUrlsBatch
} from "./helper/dependency-finder";

type Dependency = { name: string; url: string };

export class SidebarProvider implements vscode.WebviewViewProvider {
  private allDependencies: Dependency[] = [];

  constructor(private readonly context: vscode.ExtensionContext) { }

  async resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getHtml();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case "ready":
          console.log("[DocLense] Webview signaled READY");
          await this.loadDependencies(webviewView);
          break;

        case "openDoc":
          this.openInWebviewPanel(message.url);
          break;

        case "search":
          webviewView.webview.postMessage({
            type: "dependencies",
            data: this.filterDependencies(message.query)
          });
          break;
      }
    });
  }

  /* -------------------- DATA FLOW -------------------- */

  private async loadDependencies(webviewView: vscode.WebviewView) {
    const cacheKey = this.getCacheKey();
    console.log(`[DocLense] Cache key: ${cacheKey}`);

    // 1️⃣ Load from cache instantly
    const cached = this.context.workspaceState.get<Dependency[]>(cacheKey);
    if (cached?.length) {
      console.log(`[DocLense] ✅ Cache hit: ${cached.length} dependencies loaded from cache`);
      this.allDependencies = cached;
      webviewView.webview.postMessage({
        type: "dependencies",
        data: cached
      });
    } else {
      console.log('[DocLense] ❌ Cache miss: no cached dependencies found');
    }

    // 2️⃣ Refresh in background
    console.log('[DocLense] 🔄 Starting background refresh...');
    webviewView.webview.postMessage({ type: "loading", value: true });

    const fresh = await this.computeDependencies();

    // 3️⃣ Update only if changed
    if (!this.isSameDeps(cached, fresh)) {
      console.log(`[DocLense] 🆕 Dependencies changed: updating cache with ${fresh.length} dependencies`);
      this.allDependencies = fresh;
      this.context.workspaceState.update(cacheKey, fresh);

      webviewView.webview.postMessage({
        type: "dependencies",
        data: fresh
      });
    } else {
      console.log('[DocLense] ✓ Dependencies unchanged: cache is up to date');
    }

    webviewView.webview.postMessage({ type: "loading", value: false });
  }

  private async computeDependencies(): Promise<Dependency[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
      console.log('[DocLense] ⚠️ No workspace folder found');
      return [];
    }

    console.log(`[DocLense] 📂 Scanning workspace: ${workspaceFolder.fsPath}`);
    const pkgFiles = await findPackageJsonFiles(workspaceFolder);
    console.log(`[DocLense] 📦 Found ${pkgFiles.length} package.json file(s)`);

    const depSet = new Set<string>();

    for (const pkg of pkgFiles) {
      const info = await readDependencies(pkg);
      console.log(`[DocLense]   → ${info.path}: ${info.deps.length} dependencies`);
      info.deps.forEach(dep => depSet.add(dep));
    }

    const depNames = [...depSet];
    console.log(`[DocLense] 📊 Total unique dependencies: ${depNames.length}`);
    console.log(`[DocLense] 🌐 Fetching documentation URLs...`);

    const urlMap = await getDocumentationUrlsBatch(depNames, 10);

    return depNames.map(name => ({
      name,
      url: urlMap.get(name) || `https://www.npmjs.com/package/${name}`
    }));
  }

  /* -------------------- HELPERS -------------------- */

  private filterDependencies(query: string): Dependency[] {
    if (!query?.trim()) return this.allDependencies;

    const q = query.toLowerCase();
    return this.allDependencies.filter(dep =>
      dep.name.toLowerCase().includes(q)
    );
  }

  private getCacheKey(): string {
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "default";
    return `doclenseDeps:${workspacePath}`;
  }

  private isSameDeps(a?: Dependency[], b?: Dependency[]) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  }

  /* -------------------- DOC VIEWER -------------------- */

  private async openInWebviewPanel(url: string) {
    // 1. Pre-flight check: See if the site explicitly blocks embedding
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
      const xFrame = response.headers.get('x-frame-options')?.toLowerCase();
      const csp = response.headers.get('content-security-policy')?.toLowerCase();

      if (xFrame === 'deny' || xFrame === 'sameorigin' || csp?.includes("frame-ancestors 'none'")) {
        console.log(`[DocLense] Embedding blocked by headers for ${url}. Opening externally.`);
        vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
    } catch (e) {
      // If HEAD request fails or times out, proceed to webview as fallback
      console.log(`[DocLense] Pre-flight check failed for ${url}, trying webview.`);
    }

    const panel = vscode.window.createWebviewPanel(
      "doclenseDocViewer",
      "Documentation",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          html, body {
            margin: 0; padding: 0; height: 100%; overflow: hidden;
            background: #1e1e1e;
          }
          iframe {
            width: 100%; height: 100%; border: none;
          }
          .loading-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            display: flex; justify-content: center; align-items: center;
            background: #1e1e1e; color: #ccc; font-family: sans-serif;
          }
          .controls {
            position: fixed; top: 10px; right: 10px; z-index: 100;
          }
          button {
            background: #333; color: white; border: 1px solid #555;
            padding: 4px 8px; cursor: pointer; border-radius: 4px;
          }
          button:hover { background: #444; }
        </style>
      </head>
      <body>
        <div class="controls">
          <button onclick="openExternal()">Open in Browser ↗</button>
        </div>
        <div id="loader" class="loading-overlay">Loading documentation...</div>
        <iframe id="frame" src="${url}"></iframe>

        <script>
          const vscode = acquireVsCodeApi();
          const iframe = document.getElementById("frame");
          const loader = document.getElementById("loader");

          function openExternal() {
            vscode.postMessage({ type: 'openExternal' });
          }

          iframe.addEventListener("load", () => {
            loader.style.display = "none";
          });
        </script>
      </body>
      </html>
    `;

    panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'openExternal') {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    });
  }

  /* -------------------- UI -------------------- */

  private getHtml(): string {
    const nonce = Date.now().toString();

    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <link href="https://cdn.jsdelivr.net/npm/beercss@3.11.33/dist/cdn/beer.min.css" rel="stylesheet">
      <script type="module" src="https://cdn.jsdelivr.net/npm/beercss@3.11.33/dist/cdn/beer.min.js"></script>

      <style>
        body {
          margin: 0;
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: var(--vscode-editor-background);
          color: var(--vscode-editor-foreground);
          font-family: var(--vscode-font-family);
          padding: 16px;
          box-sizing: border-box;
        }

        .dep-item {
          padding: 8px 12px;
          cursor: pointer;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: background 0.1s ease;
          margin-bottom: 2px;
        }

        .dep-item:hover {
          background: var(--vscode-list-hoverBackground);
          color: var(--vscode-list-hoverForeground);
        }

        .dep-item span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          margin-right: 12px;
          font-size: 13px;
        }

        .dep-item i {
          flex-shrink: 0;
          opacity: 0.6;
          font-size: 16px;
        }

        .dep-item:hover i {
          opacity: 1;
        }

        #list {
          list-style: none;
          padding: 0;
          margin: 0;
          overflow-y: auto;
        }
      </style>
    </head>

    <body>
      <h5>DocLense</h5>
      <p class="small">Instant docs for your dependencies</p>

      <div class="field prefix round fill">
        <i>search</i>
        <input id="search" placeholder="Search dependencies..." />
      </div>

      <!-- 👇 remaining space -->
      <div id="content">
        <div id="loading">
          <div class="shape loading-indicator small"></div>
          <p>Getting Dependencies...</p>
        </div>

        <ul id="list" class="list"></ul>
      </div>

      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const list = document.getElementById("list");
        const search = document.getElementById("search");
        const loading = document.getElementById("loading");

        window.addEventListener("message", e => {
          if (e.data.type === "dependencies") render(e.data.data);

          if (e.data.type === "loading") {
            const isLoading = e.data.value;
            loading.style.display = isLoading ? "flex" : "none";
            list.style.display = isLoading ? "none" : "block";
          }
        });

        search.addEventListener("input", () => {
          vscode.postMessage({
            type: "search",
            query: search.value
          });
        });

        // Tell extension we're ready
        vscode.postMessage({ type: "ready" });

        function render(deps) {
          list.innerHTML = "";
          deps.forEach(dep => {
            const li = document.createElement("li");
            li.className = "dep-item";
            li.innerHTML = \`
              <span>\${dep.name}</span>
              <i class="small">open_in_new</i>
            \`;
            li.onclick = () =>
              vscode.postMessage({ type: "openDoc", url: dep.url });
            list.appendChild(li);
          });
        }
      </script>
    </body>
    </html>
  `;
  }
}