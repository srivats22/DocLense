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

    try {
      const freshResult = await this.computeDependencies();

      if (!freshResult.isNpm) {
        webviewView.webview.postMessage({
          type: "error",
          message: "No package.json found. DocLense works with npm-based projects."
        });
      } else {
        // 3️⃣ Update only if changed
        if (!this.isSameDeps(cached, freshResult.deps)) {
          console.log(`[DocLense] 🆕 Dependencies changed: updating cache with ${freshResult.deps.length} dependencies`);
          this.allDependencies = freshResult.deps;
          this.context.workspaceState.update(cacheKey, freshResult.deps);

          webviewView.webview.postMessage({
            type: "dependencies",
            data: freshResult.deps
          });
        } else {
          console.log('[DocLense] ✓ Dependencies unchanged: cache is up to date');
        }
      }
    } catch (err) {
      console.error('[DocLense] Error computing dependencies:', err);
      webviewView.webview.postMessage({
        type: "error",
        message: "Failed to scan dependencies."
      });
    }

    webviewView.webview.postMessage({ type: "loading", value: false });
  }

  private async computeDependencies(): Promise<{ deps: Dependency[], isNpm: boolean }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
      console.log('[DocLense] ⚠️ No workspace folder found');
      return { deps: [], isNpm: false };
    }

    console.log(`[DocLense] 📂 Scanning workspace: ${workspaceFolder.fsPath}`);
    const pkgFiles = await findPackageJsonFiles(workspaceFolder);
    console.log(`[DocLense] 📦 Found ${pkgFiles.length} package.json file(s)`);

    if (pkgFiles.length === 0) {
      return { deps: [], isNpm: false };
    }

    const depSet = new Set<string>();

    for (const pkg of pkgFiles) {
      const info = await readDependencies(pkg);
      console.log(`[DocLense]   → ${info.path}: ${info.deps.length} dependencies`);
      info.deps.forEach(dep => depSet.add(dep));
    }

    const depNames = [...depSet];
    console.log(`[DocLense] 📊 Total unique dependencies: ${depNames.length}`);

    if (depNames.length === 0) {
      return { deps: [], isNpm: true };
    }

    console.log(`[DocLense] 🌐 Fetching documentation URLs...`);
    const urlMap = await getDocumentationUrlsBatch(depNames, 10);

    const deps = depNames.map(name => ({
      name,
      url: urlMap.get(name) || `https://www.npmjs.com/package/${name}`
    }));

    return { deps, isNpm: true };
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
          padding: 12px;
          box-sizing: border-box;
        }

        h5 { margin: 0; }
        p.small { margin: 2px 0 12px 0; opacity: 0.7; }

        .field {
          margin-bottom: 8px !important;
          background: var(--vscode-editor-background);
        }

        .field.small {
          height: 36px !important;
          min-height: 36px !important;
        }

        .field i {
          font-size: 18px !important;
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

      <div class="field prefix round fill small">
        <i>search</i>
        <input id="search" placeholder="Search dependencies..." />
      </div>

      <!-- 👇 remaining space -->
      <div id="content">
        <div id="loading">
          <div class="shape loading-indicator small"></div>
          <p>Getting Dependencies...</p>
        </div>

        <div id="error-container" style="display: none; padding: 20px; text-align: center;">
          <i class="extra" style="font-size: 48px; opacity: 0.5; margin-bottom: 16px;">warning</i>
          <h6 id="error-title">Unsupported Project</h6>
          <p id="error-message" class="small">This extension only works with npm-based projects containing a package.json file.</p>
        </div>

        <ul id="list" class="list"></ul>
      </div>

      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const list = document.getElementById("list");
        const search = document.getElementById("search");
        const searchContainer = search.parentElement;
        const loading = document.getElementById("loading");
        const errorContainer = document.getElementById("error-container");
        const errorMessage = document.getElementById("error-message");

        window.addEventListener("message", e => {
          if (e.data.type === "dependencies") {
            render(e.data.data);
            errorContainer.style.display = "none";
            searchContainer.style.display = "flex";
          }

          if (e.data.type === "error") {
            loading.style.display = "none";
            list.style.display = "none";
            searchContainer.style.display = "none";
            errorContainer.style.display = "block";
            if (e.data.message) errorMessage.innerText = e.data.message;
          }

          if (e.data.type === "loading") {
            const isLoading = e.data.value;
            loading.style.display = isLoading ? "flex" : "none";
            if (isLoading) {
              list.style.display = "none";
              errorContainer.style.display = "none";
            } else if (errorContainer.style.display !== "block") {
              list.style.display = "block";
            }
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
          if (deps.length === 0 && errorContainer.style.display !== "block") {
            const li = document.createElement("li");
            li.style.padding = "20px";
            li.style.textAlign = "center";
            li.style.opacity = "0.6";
            li.innerText = "No dependencies found";
            list.appendChild(li);
            return;
          }

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