import * as vscode from "vscode";
import {
  findPackageJsonFiles,
  readDependencies,
  getDocumentationUrlsBatch
} from "./helper/dependency-finder";
import {
  findPubspecFiles,
  readFlutterDependencies,
  getFlutterPkgDocUrl
} from "./helper/flutter-finder";

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

      if (!freshResult.hasProjects) {
        webviewView.webview.postMessage({
          type: "error",
          message: "No package.json or pubspec.yaml found. DocLense works with npm and Flutter projects."
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

  private async computeDependencies(): Promise<{ deps: Dependency[], hasProjects: boolean }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
      console.log('[DocLense] ⚠️ No workspace folder found');
      return { deps: [], hasProjects: false };
    }

    console.log(`[DocLense] 📂 Scanning workspace: ${workspaceFolder.fsPath}`);

    // 1️⃣ Find project files
    const [pkgFiles, pubspecFiles] = await Promise.all([
      findPackageJsonFiles(workspaceFolder),
      findPubspecFiles(workspaceFolder)
    ]);

    console.log(`[DocLense] 📦 Found ${pkgFiles.length} package.json and ${pubspecFiles.length} pubspec.yaml file(s)`);

    if (pkgFiles.length === 0 && pubspecFiles.length === 0) {
      return { deps: [], hasProjects: false };
    }

    const npmDepSet = new Set<string>();
    const flutterDepSet = new Set<string>();

    // 2️⃣ Read npm dependencies
    for (const pkg of pkgFiles) {
      const info = await readDependencies(pkg);
      info.deps.forEach(dep => npmDepSet.add(dep));
    }

    // 3️⃣ Read flutter dependencies
    for (const pubspec of pubspecFiles) {
      const deps = await readFlutterDependencies(pubspec).catch(() => []);
      deps.forEach(dep => flutterDepSet.add(dep));
    }

    const npmDepNames = [...npmDepSet];
    const flutterDepNames = [...flutterDepSet];

    console.log(`[DocLense] 📊 Total unique: ${npmDepNames.length} npm, ${flutterDepNames.length} flutter`);

    // 4️⃣ Fetch documentation URLs
    const [npmUrlMap, flutterUrlMap] = await Promise.all([
      getDocumentationUrlsBatch(npmDepNames, 10),
      // For Flutter, we'll fetch in parallel
      Promise.all(flutterDepNames.map(async name => {
        const url = await getFlutterPkgDocUrl(name);
        return [name, url] as [string, string];
      })).then(entries => new Map<string, string>(entries))
    ]);

    // 5️⃣ Combine results
    const deps: Dependency[] = [
      ...npmDepNames.map(name => ({
        name,
        url: npmUrlMap.get(name) || `https://www.npmjs.com/package/${name}`
      })),
      ...flutterDepNames.map(name => ({
        name,
        url: flutterUrlMap.get(name) || `https://pub.dev/packages/${name}`
      }))
    ];

    // Sort alphabetically
    deps.sort((a, b) => a.name.localeCompare(b.name));

    return { deps, hasProjects: true };
  }

  /* -------------------- HELPERS -------------------- */

  private filterDependencies(query: string): Dependency[] {
    if (!query?.trim()) {
      return this.allDependencies;
    }

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
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
      const xFrame = response.headers.get('x-frame-options')?.toLowerCase();
      const csp = response.headers.get('content-security-policy')?.toLowerCase();

      if (xFrame === 'deny' || xFrame === 'sameorigin' || csp?.includes("frame-ancestors 'none'")) {
        vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
    } catch (e) {
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
            position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%);
            z-index: 100;
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
          <p id="error-message" class="small">This extension works with npm or Flutter projects containing a package.json or pubspec.yaml file.</p>
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