import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { StateWatcher, Farmer, FocusRequest } from './stateWatcher';
import { installHooks, uninstallHooks } from './hookInstaller';

let watcher: StateWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  watcher = new StateWatcher();
  await watcher.start();
  context.subscriptions.push({ dispose: () => watcher?.dispose() });

  context.subscriptions.push(
    watcher.onDidRequestFocus((req) => handleIncomingFocusRequest(watcher!, req)),
    vscode.commands.registerCommand('rice.openField', () => {
      RiceFieldPanel.show(context.extensionUri, watcher!);
    }),
    vscode.commands.registerCommand('rice.installHooks', async () => {
      try {
        const p = await installHooks(context.extensionUri);
        vscode.window.showInformationMessage(
          `Rice hooks installed in ${p}. Start a Claude Code session to see mascots.`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Rice: install failed — ${msg}`);
      }
    }),
    vscode.commands.registerCommand('rice.uninstallHooks', async () => {
      try {
        await uninstallHooks();
        vscode.window.showInformationMessage('Rice hooks removed from ~/.claude/settings.json.');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Rice: uninstall failed — ${msg}`);
      }
    })
  );
}

export function deactivate(): void {
  watcher?.dispose();
}

class RiceFieldPanel {
  private static current: RiceFieldPanel | undefined;
  private static readonly viewType = 'rice.field';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly watcher: StateWatcher;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, watcher: StateWatcher): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (RiceFieldPanel.current) {
      RiceFieldPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      RiceFieldPanel.viewType,
      'Rice Field',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );
    RiceFieldPanel.current = new RiceFieldPanel(panel, extensionUri, watcher);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, watcher: StateWatcher) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.watcher = watcher;
    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg && msg.type === 'ready') {
        this.push(this.watcher.getAll());
      } else if (msg && msg.type === 'focusTerminal' && typeof msg.id === 'string') {
        const farmer = this.watcher.getAll().find((f) => f.id === msg.id);
        if (farmer) await focusTerminalForFarmer(farmer, this.watcher);
      }
    }, null, this.disposables);

    this.disposables.push(this.watcher.onDidChange((farmers) => this.push(farmers)));
    this.push(this.watcher.getAll());
  }

  private push(farmers: Farmer[]): void {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const enriched = farmers.map((f) => {
      let plotId: string | undefined;
      if (f.cwd) {
        const matchedRoot = roots.find((r) => f.cwd!.startsWith(r));
        plotId = path.basename(matchedRoot ?? f.cwd);
      }
      return { ...f, plotId };
    });
    this.panel.webview.postMessage({ type: 'farmers', farmers: enriched });
  }

  private render(): string {
    const nonce = getNonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'rice-field.html');
    const template = fs.readFileSync(htmlPath, 'utf8');
    return template
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cspSource}}/g, this.panel.webview.cspSource);
  }

  private dispose(): void {
    RiceFieldPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

async function focusTerminalForFarmer(farmer: Farmer, watcher: StateWatcher): Promise<void> {
  const local = await findLocalTerminal(farmer);
  if (local) {
    local.show();
    return;
  }
  const requestPath = await watcher.requestFocus(farmer.id);
  setTimeout(async () => {
    try {
      await fsp.access(requestPath);
    } catch {
      return;
    }
    await fsp.unlink(requestPath).catch(() => {});
    const where = farmer.cwd ? ` (${farmer.cwd})` : '';
    vscode.window.showInformationMessage(
      `Rice: no VS Code window has a terminal for ${farmer.name}${where}. Is claude running in an integrated terminal?`
    );
  }, 1500);
}

async function handleIncomingFocusRequest(watcher: StateWatcher, req: FocusRequest): Promise<void> {
  const farmer = watcher.getAll().find((f) => f.id === req.sessionId);
  if (!farmer) return;
  const term = await findLocalTerminal(farmer);
  if (!term) return;
  term.show();
  raiseThisWindow(farmer);
  await fsp.unlink(req.filePath).catch(() => {});
}

async function findLocalTerminal(farmer: Farmer): Promise<vscode.Terminal | undefined> {
  return (
    (await findTerminalByPids(farmer.ancestorPids)) ??
    (farmer.cwd ? findTerminalByCwd(farmer.cwd) : undefined)
  );
}

function raiseThisWindow(farmer: Farmer): void {
  if (process.platform !== 'darwin') return;
  const titleHint = pickTitleHint(farmer);
  const script = titleHint
    ? `tell application "Visual Studio Code" to activate
       delay 0.05
       tell application "System Events"
         tell process "Code"
           try
             perform action "AXRaise" of (first window whose name contains ${appleStringLiteral(titleHint)})
           end try
         end tell
       end tell`
    : `tell application "Visual Studio Code" to activate`;
  child_process.execFile('osascript', ['-e', script], () => {});
}

function pickTitleHint(farmer: Farmer): string | undefined {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (farmer.cwd) {
    const match = roots.find((r) => farmer.cwd!.startsWith(r));
    if (match) return path.basename(match);
  }
  return farmer.plotId;
}

function appleStringLiteral(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function findTerminalByPids(
  ancestors: number[] | undefined
): Promise<vscode.Terminal | undefined> {
  if (!ancestors || ancestors.length === 0) return undefined;
  const set = new Set(ancestors);
  for (const t of vscode.window.terminals) {
    const pid = await t.processId;
    if (typeof pid === 'number' && set.has(pid)) return t;
  }
  return undefined;
}

function findTerminalByCwd(cwd: string): vscode.Terminal | undefined {
  for (const t of vscode.window.terminals) {
    const opt = t.creationOptions as vscode.TerminalOptions | undefined;
    const raw = opt?.cwd;
    if (!raw) continue;
    const tCwd = typeof raw === 'string' ? raw : raw.fsPath;
    if (tCwd === cwd) return t;
  }
  return undefined;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
