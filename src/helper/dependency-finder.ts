import * as vscode from "vscode";

// Cache to avoid fetching the same package multiple times
const urlCache = new Map<string, string>();

export async function findPackageJsonFiles(
    root: vscode.Uri
): Promise<vscode.Uri[]> {
    const results: vscode.Uri[] = [];

    async function scan(dir: vscode.Uri) {
        const entries = await vscode.workspace.fs.readDirectory(dir);

        for (const [name, type] of entries) {
            // skip large useless folders
            if (name === "node_modules" || name === ".git") {
                continue;
            }

            const fullPath = vscode.Uri.joinPath(dir, name);

            if (type === vscode.FileType.Directory) {
                await scan(fullPath);
            } else if (name === "package.json") {
                console.log(`[DocLense]   🔍 Found package.json: ${fullPath.fsPath}`);
                results.push(fullPath);
            }
        }
    }

    await scan(root);
    return results;
}

export async function readDependencies(pkgUri: vscode.Uri) {
    const bytes = await vscode.workspace.fs.readFile(pkgUri);
    const json = JSON.parse(new TextDecoder().decode(bytes));

    const deps = Object.keys({
        ...(json.dependencies ?? {}),
        ...(json.devDependencies ?? {}),
    });

    console.log(`[DocLense]     📝 Reading from: ${pkgUri.fsPath}`);
    console.log(`[DocLense]        - dependencies: ${Object.keys(json.dependencies ?? {}).length}`);
    console.log(`[DocLense]        - devDependencies: ${Object.keys(json.devDependencies ?? {}).length}`);

    return {
        path: pkgUri.fsPath,
        deps,
    };
}

export async function getDocumentationUrl(pkgName: string): Promise<string> {
    // Check cache first
    if (urlCache.has(pkgName)) {
        return urlCache.get(pkgName)!;
    }

    // Always fallback to npmjs
    const npmUrl = `https://www.npmjs.com/package/${pkgName}`;

    try {
        const response = await fetch(`https://registry.npmjs.org/${pkgName}`, {
            // Add timeout to prevent hanging
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
            urlCache.set(pkgName, npmUrl);
            return npmUrl;
        }

        const data: any = await response.json();

        let finalUrl = npmUrl;

        // Best option: homepage field
        if (data.homepage) {
            finalUrl = data.homepage;
        }
        // Fallback to repository
        else if (data.repository?.url) {
            finalUrl = data.repository.url.replace("git+", "").replace(".git", "");
        }

        // Cache the result
        urlCache.set(pkgName, finalUrl);
        return finalUrl;
    } catch {
        urlCache.set(pkgName, npmUrl);
        return npmUrl;
    }
}

/**
 * Batch fetch documentation URLs for multiple packages in parallel
 */
export async function getDocumentationUrlsBatch(
    pkgNames: string[],
    batchSize: number = 10
): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < pkgNames.length; i += batchSize) {
        const batch = pkgNames.slice(i, i + batchSize);

        // Fetch all URLs in this batch in parallel
        const batchResults = await Promise.all(
            batch.map(async (pkgName) => {
                const url = await getDocumentationUrl(pkgName);
                return { pkgName, url };
            })
        );

        // Store results
        batchResults.forEach(({ pkgName, url }) => {
            results.set(pkgName, url);
        });
    }

    return results;
}

/**
 * Clear the URL cache (useful for refresh)
 */
export function clearUrlCache() {
    urlCache.clear();
}