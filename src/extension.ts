// The module 'vscode' contains the VS Code extensibility API
import * as vscode from "vscode";
import { SidebarProvider } from "./side-bar";

// Make activate() async so you can use await
export async function activate(context: vscode.ExtensionContext) {
    // Register your sidebar
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "doclense-sidebar-view",
            new SidebarProvider(context)
        )
    );

    // Optional command to open the sidebar
    context.subscriptions.push(
        vscode.commands.registerCommand("doclense-sidebar.open", () => {
            vscode.commands.executeCommand("workbench.view.extension.doclense-sidebar");
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() {}