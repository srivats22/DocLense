/*
flutter-finder.ts
Helper file to find documentation urls for flutter packages
*/

import * as vscode from "vscode";
import YAML from "yaml";

/**
 * Reads flutter dependencies from pubspec.yaml
 */
export async function readFlutterDependencies(
    pubspecUri: vscode.Uri
): Promise<string[]> {
    const bytes = await vscode.workspace.fs.readFile(pubspecUri);
    const content = Buffer.from(bytes).toString("utf8");

    const doc = YAML.parse(content);

    const deps = {
        ...doc.dependencies,
        ...doc.dev_dependencies
    };

    return Object.keys(deps || {}).filter(name => name !== "flutter");
}

/**
 * Finds all pubspec.yaml files in the workspace
 */
export async function findPubspecFiles(
    root: vscode.Uri
): Promise<vscode.Uri[]> {
    const results: vscode.Uri[] = [];

    async function scan(dir: vscode.Uri) {
        const entries = await vscode.workspace.fs.readDirectory(dir);

        for (const [name, type] of entries) {
            // skip common large folders
            if (name === "node_modules" || name === ".git" || name === "build" || name === ".dart_tool") {
                continue;
            }

            const fullPath = vscode.Uri.joinPath(dir, name);

            if (type === vscode.FileType.Directory) {
                await scan(fullPath);
            } else if (name === "pubspec.yaml") {
                results.push(fullPath);
            }
        }
    }

    await scan(root);
    return results;
}

/**
 * Fetches the documentation URL for a Flutter package from pub.dev
 */
export async function getFlutterPkgDocUrl(pkgName: string): Promise<string> {
    const baseUrl = "https://pub.dev/api/packages/";
    const packageUrl = baseUrl + pkgName;
    const fallbackUrl = `https://pub.dev/packages/${pkgName}`;

    try {
        const resp = await fetch(packageUrl);
        if (resp.ok) {
            const data: any = await resp.json();
            const pubspec = data.latest?.pubspec;
            if (pubspec) {
                if (pubspec.repository) {
                    return pubspec.repository;
                }
                if (pubspec.homepage) {
                    return pubspec.homepage;
                }
                return fallbackUrl;
            }
        }
    } catch (e) {
        console.error(`[DocLense] Error fetching Flutter package doc for ${pkgName}:`, e);
    }

    return fallbackUrl;
}