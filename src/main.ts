import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { window, commands, workspace, OutputChannel, ExtensionContext, ViewColumn, QuickPickItem, Terminal } from 'vscode';
import { runInTerminal } from 'run-in-terminal';
import { kill } from 'tree-kill';

interface Script extends QuickPickItem {
	scriptName: string;
	cwd: string;
	execute(): void;
}

interface Process {
	process: cp.ChildProcess;
	cmd: string;
}

class ProcessItem implements QuickPickItem {
	constructor (public label: string, public description: string, public pid: number) {}
}

const runningProcesses: Map<number, Process> = new Map();

let outputChannel: OutputChannel;
let terminal: Terminal = null;
let lastScript: Script = null;

export function activate(context: ExtensionContext) {
	registerCommands(context);
	outputChannel = window.createOutputChannel('npm');
	context.subscriptions.push(outputChannel);
}

export function deactivate() {
	if (terminal) {
		terminal.dispose();
	}
}

function registerCommands(context: ExtensionContext) {
	context.subscriptions.push(
		commands.registerCommand('npm-script.install', runNpmInstall),
		commands.registerCommand('npm-script.test', runNpmTest),
		commands.registerCommand('npm-script.run', runNpmScript),
		commands.registerCommand('npm-script.showOutput', showNpmOutput),
		commands.registerCommand('npm-script.rerun-last-script', rerunLastScript),
		commands.registerCommand('npm-script.build', runNpmBuild),
		commands.registerCommand('npm-script.terminate-script', terminateScript)
	);
}

function runNpmInstall() {
	let dirs = getIncludedDirectories();
	for (let dir of dirs) {
		runNpmCommand(['install'], dir);
	}
}

function runNpmTest() {
	runNpmCommand(['test']);
}

function runNpmBuild() {
	runNpmCommand(['run-script', 'build']);
}

function showNpmOutput(): void {
	outputChannel.show(ViewColumn.Three);
}

function runNpmScript(): void {
	let scripts = readScripts();
	if (!scripts) {
		return;
	}
	let scriptList: Script[] = [];
	for (let s of scripts) {
		let label = s.name;
		if (s.relativePath) {
			label = `${s.relativePath}: ${label}`;
		}
		scriptList.push({
			label: label,
			description: s.cmd,
			scriptName: s.name,
			cwd: s.absolutePath,
			execute() {
				lastScript = this;
				runNpmCommand(['run-script', this.scriptName], this.cwd);
			}
		});
	}

	window.showQuickPick(scriptList).then(script => {
		if (script) {
			return script.execute();
		}
	});
};

function rerunLastScript(): void {
	if (lastScript) {
		lastScript.execute();
	} else {
		runNpmScript();
	}
}

function terminateScript(): void {
	if(useTerminal()) {
		window.showInformationMessage('Killing is only supported when the setting "runInTerminal" is "false"');
	} else {
		let items: ProcessItem[] = [];

		runningProcesses.forEach((value) => {
			items.push(new ProcessItem(value.cmd, `kill the process ${value.process.pid}`, value.process.pid));
		});

		window.showQuickPick(items).then((value) => {
			if(value) {
				outputChannel.appendLine('');
				outputChannel.appendLine(`Killing process ${value.label} (pid: ${value.pid})`);
				outputChannel.appendLine('');
				kill(value.pid, 'SIGTERM');
			}
		});
	}
}

function readScripts(): any {
	let includedDirectories = getIncludedDirectories();
	let scripts = [];
	let fileName = "";
	let dir: string;
	for (dir of includedDirectories) {
		try {
			fileName = path.join(dir, 'package.json');
			let contents = fs.readFileSync(fileName).toString();
			let json = JSON.parse(contents);
			if (json.scripts) {
				var jsonScripts = json.scripts;
				var absolutePath = dir;
				var relativePath = absolutePath.substring(workspace.rootPath.length + 1);
				Object.keys(jsonScripts).forEach(key => {
					scripts.push({
						absolutePath: absolutePath,
						relativePath: relativePath,
						name: `${key}`,
						cmd: `${jsonScripts[key]}`
					});
				});
			}
		} catch(e) {
			window.showInformationMessage(`Cannot read '${fileName}'`);
			return undefined;
		}
	}

	if (scripts.length === 0) {
		window.showInformationMessage('No scripts are defined');
		return undefined;
	}

	return scripts;
}

function runNpmCommand(args: string[], cwd?: string): void {
	if (runSilent()) {
		args.push('--silent');
	}
	workspace.saveAll().then(() => {
		if (!cwd) {
			cwd = workspace.rootPath;
		}

		if (useTerminal()) {
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

function runCommandInOutputWindow(args: string[], cwd: string) {
	let cmd = getNpmBin() + ' ' + args.join(' ');
	let p = cp.exec(cmd, { cwd: cwd, env: process.env });

	runningProcesses.set(p.pid, { process: p, cmd: cmd });

	p.stderr.on('data', (data: string) => {
		outputChannel.append(data);
	});
	p.stdout.on('data', (data: string) => {
		outputChannel.append(data);
	});
	p.on('exit', (code, signal) => {
		runningProcesses.delete(p.pid);

		if(signal === 'SIGTERM') {
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

function runCommandInTerminal(args: string[], cwd: string): void {
	runInTerminal(getNpmBin(), args, { cwd: cwd, env: process.env });
}

function runCommandInIntegratedTerminal(args: string[], cwd: string): void {
	if (!terminal) {
		terminal = window.createTerminal('npm');
	}
	terminal.show();
	args.splice(0, 0, getNpmBin());
	terminal.sendText(args.join(' '));
}

function useTerminal() {
	return workspace.getConfiguration('npm')['runInTerminal'];
}

function runSilent() {
	return workspace.getConfiguration('npm')['runSilent'];
}

function getIncludedDirectories() {
	let dirs = [];

	if (workspace.getConfiguration('npm')['useRootDirectory'] !== false) {
		dirs.push(workspace.rootPath);
	}

	if (workspace.getConfiguration('npm')['includeDirectories'].length > 0) {
		for (let dir of workspace.getConfiguration('npm')['includeDirectories']) {
			dirs.push(path.join(workspace.rootPath, dir));
		}
	}

	return dirs;
}

function getNpmBin() {
	return workspace.getConfiguration('npm')['bin'] || 'npm';
}
