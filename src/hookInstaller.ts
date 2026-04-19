import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const HOOK_MARKER = 'rice-hook.js';

export async function installHooks(extensionUri: vscode.Uri): Promise<string> {
  const claudeDir = path.join(os.homedir(), '.claude');
  const stateDir = path.join(claudeDir, 'rice-state');
  const hookSrc = vscode.Uri.joinPath(extensionUri, 'scripts', 'rice-hook.js').fsPath;
  const hookDst = path.join(claudeDir, 'rice-hook.js');
  const settingsPath = path.join(claudeDir, 'settings.json');

  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });

  const hookContent = await fs.readFile(hookSrc, 'utf8');
  await fs.writeFile(hookDst, hookContent);
  await fs.chmod(hookDst, 0o755);

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch {
    settings = {};
  }

  const cmdFor = (arg: string) => `node "${hookDst}" ${arg}`;
  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};

  const stripRice = (arr: unknown[] | undefined): unknown[] =>
    (arr ?? []).filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));

  hooks.SessionStart = [
    ...stripRice(hooks.SessionStart),
    { hooks: [{ type: 'command', command: cmdFor('session-start') }] },
  ];
  hooks.UserPromptSubmit = [
    ...stripRice(hooks.UserPromptSubmit),
    { hooks: [{ type: 'command', command: cmdFor('user-prompt') }] },
  ];
  hooks.PreToolUse = [
    ...stripRice(hooks.PreToolUse),
    { matcher: '*', hooks: [{ type: 'command', command: cmdFor('pre-tool') }] },
  ];
  hooks.PostToolUse = [
    ...stripRice(hooks.PostToolUse),
    { matcher: '*', hooks: [{ type: 'command', command: cmdFor('post-tool') }] },
  ];
  hooks.Stop = [
    ...stripRice(hooks.Stop),
    { hooks: [{ type: 'command', command: cmdFor('stop') }] },
  ];
  hooks.Notification = [
    ...stripRice(hooks.Notification),
    { hooks: [{ type: 'command', command: cmdFor('notification') }] },
  ];

  settings.hooks = hooks;
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

  return settingsPath;
}

export async function uninstallHooks(): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch {
    return;
  }
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return;

  const stripRice = (arr: unknown[] | undefined): unknown[] =>
    (arr ?? []).filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));

  for (const k of Object.keys(hooks)) {
    const cleaned = stripRice(hooks[k]);
    if (cleaned.length === 0) delete hooks[k];
    else hooks[k] = cleaned;
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}
