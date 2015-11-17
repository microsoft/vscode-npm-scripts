import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { window, commands, workspace, OutputChannel, ExtensionContext, ViewColumn, QuickPickItem } from 'vscode';
import { runInTerminal } from 'run-in-terminal';

interface Script extends QuickPickItem {
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
	runNpmCommand(['install']);
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
	Object.keys(scripts).forEach(key => {
		scriptList.push({
			label: `${key}`,
			description: `${scripts[key]}`,
			execute() {
				lastScript = this;
				runNpmCommand(['run-script', key]);
			}
		});
	});

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
	let fileName = path.join(workspace.rootPath, 'package.json');
	try {
		let contents = fs.readFileSync(fileName).toString();
		let json = JSON.parse(contents);
		if (json.scripts) {
			return json.scripts;
		}
		window.showInformationMessage('No scripts are defined in \'package.json\'');
		return undefined;
	} catch(e) {
		window.showInformationMessage('Cannot read \'package.json\'');
		return undefined;
	}
}

function runNpmCommand(args: string[]): void {
	if (useTerminal()) {
		runCommandInTerminal(args);
	} else {
		runCommandInOutputWindow(args);
	}
}

function runCommandInOutputWindow(args: string[]) {
	let cmd = 'npm ' + args.join(' ');
	let p = cp.exec(cmd, { cwd: workspace.rootPath, env: process.env });
	p.stderr.on('data', (data: string) => {
		outputChannel.append(data);
	});
	p.stdout.on('data', (data: string) => {
		outputChannel.append(data);
	});
	showNpmOutput();
}

function runCommandInTerminal(args: string[]): void {
	runInTerminal('npm', args, { cwd: workspace.rootPath, env: process.env });
}

function useTerminal() {
	return workspace.getConfiguration('npm')['runInTerminal'];
}