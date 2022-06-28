import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import {
	window, commands, workspace, OutputChannel, ExtensionContext, ViewColumn,
	QuickPickItem, Terminal, Uri, ConfigurationTarget, env
} from 'vscode';

import { runInTerminal } from 'run-in-terminal';
import { kill } from 'tree-kill';

interface Script extends QuickPickItem {
	scriptName: string;
	cwd: string | undefined;
	execute(): void;
}

interface Process {
	process: cp.ChildProcess;
	cmd: string;
}

class ProcessItem implements QuickPickItem {
	constructor(public label: string, public description: string, public pid: number) { }
}

interface ScriptCommandDescription {
	absolutePath: string;
	relativePath: string | undefined; // path relative to workspace root, if there is a root
	name: string;
	cmd: string;
}

interface CommandArgument {
	fsPath: string;
}

const runningProcesses: Map<number, Process> = new Map();

let outputChannel: OutputChannel;
let terminal: Terminal | null = null;
let lastScript: Script | null = null;

export function activate(context: ExtensionContext) {
	registerCommands(context);

	outputChannel = window.createOutputChannel('npm');
	context.subscriptions.push(outputChannel);

	window.onDidCloseTerminal((closedTerminal) => {
		if (terminal === closedTerminal) {
			terminal = null;
		}
	});

}

export function deactivate() {
	if (terminal) {
		terminal.dispose();
	}
}

function registerCommands(context: ExtensionContext) {
	async function showKeybindingsChangedWarning(): Promise<void> {
		const configuration = workspace.getConfiguration();

		// this should not happen since the command should only be available when the setting is false
		if (configuration.get<boolean>("npm.keybindingsChangedWarningShown", false)) {
			return;
		};
		const learnMore = "Learn More";
		const result = await window.showInformationMessage("The key bindings of the 'npm-scripts' extension have changed!", { 'modal': true}, learnMore);
		if (result === learnMore) {
			env.openExternal(Uri.parse('https://github.com/microsoft/vscode-npm-scripts#keyboard-shortcuts'));
		}
		await configuration.update('npm.keybindingsChangedWarningShown', true, ConfigurationTarget.Global);
	}

	context.subscriptions.push(
		commands.registerCommand('npm-script.install', runNpmInstall),
		commands.registerCommand('npm-script.init', runNpmInit),
		commands.registerCommand('npm-script.test', runNpmTest),
		commands.registerCommand('npm-script.start', runNpmStart),
		commands.registerCommand('npm-script.run', runNpmScript),
		commands.registerCommand('npm-script.showOutput', showNpmOutput),
		commands.registerCommand('npm-script.rerun-last-script', rerunLastScript),
		commands.registerCommand('npm-script.build', runNpmBuild),
		commands.registerCommand('npm-script.audit', runNpmAudit),
		commands.registerCommand('npm-script.outdated', runNpmOutdated),
		commands.registerCommand('npm-script.installInOutputWindow', runNpmInstallInOutputWindow),
		commands.registerCommand('npm-script.uninstallInOutputWindow', runNpmUninstallInOutputWindow),
		commands.registerCommand('npm-script.terminate-script', terminateScript),
		commands.registerCommand('npm-script.showKeybindingsChangedWarning', showKeybindingsChangedWarning)
	);
}

function runNpmCommand(args: string[], cwd: string | undefined, alwaysRunInputWindow = false): void {
	if (runSilent()) {
		args.push('--silent');
	}
	workspace.saveAll().then(() => {

		if (useTerminal() && !alwaysRunInputWindow) {
			if (typeof window.createTerminal === 'function') {
				runCommandInIntegratedTerminal(args, cwd);
			} else {
				runCommandInTerminal(args, cwd);
			}
		} else {
			outputChannel.clear();
			runCommandInOutputWindow(args, cwd);
		}
	});
}

function createAllCommand(scriptList: Script[], isScriptCommand: boolean): Script {
	return {
		label: "All",
		description: "Run all " + (isScriptCommand ? "scripts" : "commands") + " listed below",
		scriptName: "Dummy",
		cwd: undefined,
		execute(this: Script) {
			for (const s of scriptList) {
				// check for null ``cwd to prevent calling the function by itself.
				if (s.cwd) {
					s.execute();
				}
			}
		}
	};
}

function isMultiRoot(): boolean {
	if (workspace.workspaceFolders) {
		return workspace.workspaceFolders.length > 1;
	}
	return false;
}

function pickScriptToExecute(descriptions: ScriptCommandDescription[], command: string[], allowAll = false, alwaysRunInputWindow = false) {
	const scriptList: Script[] = [];
	const isScriptCommand = command[0] === 'run-script';

	if (allowAll && descriptions.length > 1) {
		scriptList.push(createAllCommand(scriptList, isScriptCommand));
	}
	for (const s of descriptions) {
		let label = s.name;
		if (s.relativePath) {
			label = `${s.relativePath} - ${label}`;
		}
		if (isMultiRoot()) {
			const root = workspace.getWorkspaceFolder(Uri.file(s.absolutePath));
			if (root) {
				label = `${root.name}: ${label}`;
			}
		}
		scriptList.push({
			label: label,
			description: s.cmd,
			scriptName: s.name,
			cwd: s.absolutePath,
			execute(this: Script) {
				let script = this.scriptName;
				// quote the script name, when it contains white space
				if (/\s/g.test(script)) {
					script = `"${script}"`;
				}
				// Create copy of command to ensure that we always get the correct command when the script is rerun.
				const cmd = Array.from(command);
				if (isScriptCommand) {
					lastScript = this;
					//Add script name to command array
					cmd.push(script);
				}
				runNpmCommand(cmd, this.cwd, alwaysRunInputWindow);
			}
		});
	}

	if (scriptList.length === 1) {
		scriptList[0].execute();
		return;
	} else if (scriptList.length === 0) {
		if (isScriptCommand) {
			window.showErrorMessage(`Failed to find script with "${command[1]}" command`);
		} else {
			window.showErrorMessage(`Failed to find handler for "${command[0]}" command`);
		}
		return;
	}
	window.showQuickPick(scriptList).then(script => {
		if (script) {
			script.execute();
		}
	});
}

/**
  * Executes an npm command in a package directory (or in all possible directories).
  * @param command Command name.
  * @param allowAll Allow to run the command in all possible directory locations, otherwise the user must pick a location.
  * @param dirs Array of directories used to determine locations for running the command.
        When no argument is passed then `getIncludedDirectories` is used to get list of directories.
  */
function runNpmCommandInPackages(command: string[], allowAll = false, alwaysRunInputWindow = false, dirs?: string[]) {
	const descriptions = commandsDescriptions(command, dirs);
	if (descriptions.length === 0) {
		window.showErrorMessage("No scripts found.", { modal: true });
		return;
	}
	pickScriptToExecute(descriptions, command, allowAll, alwaysRunInputWindow);
}

/**
  * The first argument in `args` must be the path to the directory where the command will be executed.
  */
function runNpmCommandWithArguments(cmd: string, args: string[]) {
	const [dir, ...args1] = args;
	runNpmCommand([cmd, ...args1], dir);
}

function runNpmInstall(arg: CommandArgument) {
	let dirs = [];
	// Is the command executed from the context menu?
	if (arg && arg.fsPath) {
		dirs.push(path.dirname(arg.fsPath));
	} else {
		dirs = getAllIncludedDirectories();
	}
	runNpmCommandInPackages(['install'], true, false, dirs);
}

function runNpmInstallInOutputWindow(...args: string[]) {
	runNpmCommandWithArguments('install', args);
}

function runNpmUninstallInOutputWindow(...args: string[]) {
	runNpmCommandWithArguments('uninstall', args);
}

function runNpmTest() {
	runNpmCommandInPackages(['test'], true);
}

function runNpmStart() {
	runNpmCommandInPackages(['start'], true);
}

function runNpmBuild() {
	runNpmCommandInPackages(['run', 'build'], true);
}

function runNpmAudit() {
	runNpmCommandInPackages(['audit'], true);
}

function runNpmOutdated() {
	runNpmCommandInPackages(['outdated'], true);
}

function runNpmInit() {
	runNpmCommandInPackages(['init'], true);
}

function runNpmScript(): void {
	runNpmCommandInPackages(['run-script'], false);
}

function rerunLastScript(): void {
	if (lastScript) {
		lastScript.execute();
	} else {
		runNpmScript();
	}
}

/**
 * Adds entries to the `description` argument based on the passed command and the package path.
 * The function has two scenarios (based on a given command name):
 *  - Adds entry with the command, it's name and paths (absolute and relative to workspace).
 *  - When the command equals to 'run-script' it reads the `package.json` and generates entries:
 *    - with all script names (when there is no script name defined),
 *    - with scripts that match the name.
 */
function commandDescriptionsInPackage(param: string[], packagePath: string, descriptions: ScriptCommandDescription[]) {
	const absolutePath = packagePath;
	const fileUri = Uri.file(absolutePath);
	const workspaceFolder = workspace.getWorkspaceFolder(fileUri);
	let rootUri: Uri | undefined = undefined;
	let relativePath: string | undefined = undefined;
	if (workspaceFolder) {
		rootUri = workspaceFolder.uri;
		relativePath = absolutePath.substring(rootUri.fsPath.length + 1);
	}

	const cmd = param[0];
	const name = param[1];

	if (cmd === 'run-script') {
		try {
			const fileName = path.join(packagePath, 'package.json');
			const contents = fs.readFileSync(fileName).toString();
			const json = JSON.parse(contents);
			if (json.scripts) {
				const jsonScripts = json.scripts;
				Object.keys(jsonScripts).forEach(key => {
					if (!name || key === name) {
						descriptions.push({
							absolutePath: absolutePath,
							relativePath: relativePath,
							name: `${key}`,
							cmd: `${cmd} ${jsonScripts[key]}`
						});
					}
				});
			}
		} catch (e) {
		}
	} else {
		descriptions.push({
			absolutePath: absolutePath,
			relativePath: relativePath,
			name: `${cmd}`,
			cmd: `npm ${cmd}`
		});
	}
}

function commandsDescriptions(command: string[], dirs: string[] | undefined): ScriptCommandDescription[] {
	if (!dirs) {
		dirs = getAllIncludedDirectories();
	}
	const descriptions: ScriptCommandDescription[] = [];
	dirs.forEach(dir => commandDescriptionsInPackage(command, dir, descriptions));
	return descriptions;
}

function showNpmOutput(): void {
	outputChannel.show(ViewColumn.Three);
}

function terminateScript(): void {
	if (useTerminal()) {
		window.showInformationMessage('Killing is only supported when the setting "runInTerminal" is "false"');
	} else {
		const items: ProcessItem[] = [];

		runningProcesses.forEach((value) => {
			items.push(new ProcessItem(value.cmd, `kill the process ${value.process.pid}`, value.process.pid));
		});

		window.showQuickPick(items).then((value) => {
			if (value) {
				outputChannel.appendLine('');
				outputChannel.appendLine(`Killing process ${value.label} (pid: ${value.pid})`);
				outputChannel.appendLine('');
				kill(value.pid, 'SIGTERM');
			}
		});
	}
}

function runCommandInOutputWindow(args: string[], cwd: string | undefined) {
	const cmd = getNpmBin() + ' ' + args.join(' ');
	const p = cp.exec(cmd, { cwd: cwd, env: process.env });

	runningProcesses.set(p.pid, { process: p, cmd: cmd });

	p.stderr.on('data', (data: string) => {
		outputChannel.append(data);
	});
	p.stdout.on('data', (data: string) => {
		outputChannel.append(data);
	});
	p.on('exit', (_code: number, signal: string) => {
		runningProcesses.delete(p.pid);

		if (signal === 'SIGTERM') {
			outputChannel.appendLine('Successfully killed process');
			outputChannel.appendLine('-----------------------');
			outputChannel.appendLine('');
		} else {
			outputChannel.appendLine('-----------------------');
			outputChannel.appendLine('');
		}
	});

	showNpmOutput();
}

function runCommandInTerminal(args: string[], cwd: string | undefined): void {
	runInTerminal(getNpmBin(), args, { cwd: cwd, env: process.env });
}

function runCommandInIntegratedTerminal(args: string[], cwd: string | undefined): void {
	const cmd_args = Array.from(args);

	if (!terminal) {
		terminal = window.createTerminal('npm');
	}
	terminal.show();
	if (cwd) {
		// Replace single backslash with double backslash.
		const textCwd = cwd.replace(/\\/g, '\\\\');
		terminal.sendText(['cd', `"${textCwd}"`].join(' '));
	}
	cmd_args.splice(0, 0, getNpmBin());
	terminal.sendText(cmd_args.join(' '));
}

function useTerminal() {
	return workspace.getConfiguration('npm')['runInTerminal'];
}

function runSilent() {
	return workspace.getConfiguration('npm')['runSilent'];
}

function getAllIncludedDirectories(): string[] {
	const allDirs: string[] = [];

	const folders = workspace.workspaceFolders;

	if (!folders) {
		return allDirs;
	}

	for (let i = 0; i < folders.length; i++) {
		if (folders[i].uri.scheme === 'file') {
			const dirs = getIncludedDirectories(folders[i].uri);
			allDirs.push(...dirs);
		}
	}
	return allDirs;
}

function getIncludedDirectories(workspaceRoot: Uri): string[] {
	const dirs: string[] = [];

	if (workspace.getConfiguration('npm', workspaceRoot)['useRootDirectory'] !== false) {
		dirs.push(workspaceRoot.fsPath);
	}

	if (workspace.getConfiguration('npm', workspaceRoot)['includeDirectories'].length > 0) {
		for (const dir of workspace.getConfiguration('npm', workspaceRoot)['includeDirectories']) {
			dirs.push(path.join(workspaceRoot.fsPath, dir));
		}
	}
	return dirs;
}

function getNpmBin() {
	return workspace.getConfiguration('npm')['bin'] || 'npm';
}
