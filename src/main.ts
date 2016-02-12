import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { window, commands, workspace, OutputChannel, ExtensionContext, ViewColumn, QuickPickItem } from 'vscode';
import { runInTerminal } from 'run-in-terminal';

interface Script extends QuickPickItem {
	scriptName: string;
	cwd: string;
	execute(): void;
}

let outputChannel: OutputChannel;
let lastScript: Script = null;

export function activate(context: ExtensionContext) {
	registerCommands(context);
	outputChannel = window.createOutputChannel('npm');
	context.subscriptions.push(outputChannel);
}

function registerCommands(context: ExtensionContext) {
	let c1 = commands.registerCommand('npm-script.showOutput', showNpmOutput);
	let c2 = commands.registerCommand('npm-script.install', runNpmInstall);
	let c3 = commands.registerCommand('npm-script.run', runNpmScript);
	let c4 = commands.registerCommand('npm-script.rerun-last-script', rerunLastScript);
	context.subscriptions.push(c1, c2, c3, c4);
}

function runNpmInstall() {
	let dirs = getIncludedDirectories();
	for (let dir of dirs) {
		runNpmCommand(['install'], dir);
	}
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

function readScripts(): any {
	let includedDirectories = getIncludedDirectories();
	let scripts = [];
	let fileName = "";
	for (let dir of includedDirectories) {
		try {
			fileName = path.join(dir, 'package.json');
			let contents = fs.readFileSync(fileName).toString();
			let json = JSON.parse(contents);
			if (json.scripts) {
				let jsonScripts = json.scripts;
				let absolutePath = dir;
				let relativePath = absolutePath.substring(workspace.rootPath.length + 1);
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
	if (!cwd) {
		cwd = workspace.rootPath;
	}

	if (useTerminal()) {
		runCommandInTerminal(args, cwd);
	} else {
		runCommandInOutputWindow(args, cwd);
	}
}

function runCommandInOutputWindow(args: string[], cwd: string) {
	let cmd = 'npm ' + args.join(' ');
	let p = cp.exec(cmd, { cwd: cwd, env: process.env });
	p.stderr.on('data', (data: string) => {
		outputChannel.append(data);
	});
	p.stdout.on('data', (data: string) => {
		outputChannel.append(data);
	});
	showNpmOutput();
}

function runCommandInTerminal(args: string[], cwd: string): void {
	runInTerminal('npm', args, { cwd: cwd, env: process.env });
}

function useTerminal() {
	return workspace.getConfiguration('npm')['runInTerminal'];
}

function getIncludedDirectories() {
	let dirs = [];
	dirs.push(workspace.rootPath);

	if (workspace.getConfiguration('npm')['includeDirectories'].length > 0) {
		for (let dir of workspace.getConfiguration('npm')['includeDirectories']) {
			dirs.push(path.join(workspace.rootPath, dir));
		}
	}

	return dirs;
}