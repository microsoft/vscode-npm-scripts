import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import {
	window, commands, workspace, languages, OutputChannel, ExtensionContext, ViewColumn,
	QuickPickItem, Terminal, DiagnosticCollection, Diagnostic, Range, TextDocument, DiagnosticSeverity,
	CodeActionProvider, CodeActionContext, CancellationToken, Command
} from 'vscode';

import { runInTerminal } from 'run-in-terminal';
import { kill } from 'tree-kill';
import { parseTree, Node, } from 'jsonc-parser';
import { ThrottledDelayer } from './async';

let diagnosticCollection: DiagnosticCollection;
let delayer: ThrottledDelayer<void> = null;

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
	constructor(public label: string, public description: string, public pid: number) { }
}

interface SourceRange {
	name: {
		offset: number;
		length: number;
	};
	version: {
		offset: number;
		length: number;
	};
}

interface DependencySourceRanges {
	[dependency: string]: SourceRange;
}

class NpmCodeActionProvider implements CodeActionProvider {
	public provideCodeActions(document: TextDocument, range: Range, context: CodeActionContext, token: CancellationToken): Command[] {
		let cmds: Command[] = [];
		context.diagnostics.forEach(diag => {
			if (diag.message.indexOf('[npm] ') === 0) {
				let [_, moduleName] = /^\[npm\] Module '(\S*)'/.exec(diag.message);
				cmds.push({
					title: `run: npm install '${moduleName}'`,
					command: 'npm-script.installInOutputWindow',
					arguments: [moduleName]
				});
				cmds.push({
					title: `run: npm install`,
					command: 'npm-script.installInOutputWindow',
					arguments: []
				});
				cmds.push({
					title: `validate installed modules`,
					command: 'npm-script.validate',
					arguments: []
				});
			}
		});
		return cmds;
	}
}

const runningProcesses: Map<number, Process> = new Map();

let outputChannel: OutputChannel;
let terminal: Terminal = null;
let lastScript: Script = null;

export function activate(context: ExtensionContext) {
	registerCommands(context);

	diagnosticCollection = languages.createDiagnosticCollection('npm-script-runner');
	context.subscriptions.push(diagnosticCollection);

	outputChannel = window.createOutputChannel('npm');
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(languages.registerCodeActionsProvider('json', new NpmCodeActionProvider()));

	workspace.onDidSaveTextDocument(document => {
		//console.log("onDidSaveTextDocument ", document.fileName);
		validateDocument(document);
	}, null, context.subscriptions);
	window.onDidChangeActiveTextEditor(editor => {
		//console.log("onDidChangeActiveTextEditor", editor.document.fileName);
		if (editor && editor.document) {
			validateDocument(editor.document);
		}
	}, null, context.subscriptions);

	// for now do not remove the markers on close
	// workspace.onDidCloseTextDocument(document => {
	// 	diagnosticCollection.clear();
	// }, null, context.subscriptions);

	// workaround for onDidOpenTextDocument
	// workspace.onDidOpenTextDocument(document => {
	// 	console.log("onDidOpenTextDocument ", document.fileName);
	// 	validateDocument(document);
	// }, null, context.subscriptions);

	window.visibleTextEditors.forEach(each => {
		if (each.document) {
			validateDocument(each.document);
		}
	});


	context.subscriptions.push();
}

export function deactivate() {
	if (terminal) {
		terminal.dispose();
	}
}

function validateDocument(document: TextDocument) {
	//console.log('validateDocument ', document.fileName);
	if (!document || path.basename(document.fileName) !== 'package.json') {
		return;
	}
	if (!delayer) {
		delayer = new ThrottledDelayer<void>(200);
	}
	//console.log('trigger');
	delayer.trigger(() => doValidate(document));
}


function validateAllDocuments() {
	workspace.textDocuments.forEach(each => validateDocument(each));
}

function registerCommands(context: ExtensionContext) {
	context.subscriptions.push(
		commands.registerCommand('npm-script.install', runNpmInstall),
		commands.registerCommand('npm-script.test', runNpmTest),
		commands.registerCommand('npm-script.start', runNpmStart),
		commands.registerCommand('npm-script.run', runNpmScript),
		commands.registerCommand('npm-script.showOutput', showNpmOutput),
		commands.registerCommand('npm-script.rerun-last-script', rerunLastScript),
		commands.registerCommand('npm-script.build', runNpmBuild),
		commands.registerCommand('npm-script.installInOutputWindow', runNpmInstallInOutputWindow),
		commands.registerCommand('npm-script.validate', validateAllDocuments),
		commands.registerCommand('npm-script.terminate-script', terminateScript)
	);
}

function runNpmInstall() {
	let dirs = getIncludedDirectories();
	for (let dir of dirs) {
		runNpmCommand(['install'], dir);
	}
}

function runNpmInstallInOutputWindow(arg) {
	let dirs = getIncludedDirectories();
	for (let dir of dirs) {
		runNpmCommand(['install', arg], dir, true);
	}
}

function runNpmTest() {
	runNpmCommand(['test']);
}

function runNpmStart() {
	runNpmCommand(['start']);
}

function runNpmBuild() {
	runNpmCommand(['run-script', 'build']);
}

function doValidate(document: TextDocument): Promise<void> {
	//console.log('do validate');
	return new Promise<void>((resolve, reject) => {

		getInstalledModules().then(result => {
			let errors = [];
			let definedDependencies: DependencySourceRanges = {};

			if (!anyModuleErrors(result)) {
				resolve();
			}

			let node = parseTree(document.getText(), errors);

			node.children.forEach(child => {
				let children = child.children;
				if (children && children.length === 2 && isDependency(children[0].value)) {
					collectDefinedDependencies(definedDependencies, child.children[1]);
				}
			});

			diagnosticCollection.clear();
			let diagnostics: Diagnostic[] = [];

			for (var moduleName in definedDependencies) {
				if (definedDependencies.hasOwnProperty(moduleName)) {
					let diagnostic = getDiagnostic(document, result, moduleName, definedDependencies[moduleName]);
					if (diagnostic) {
						diagnostics.push(diagnostic);
					}
				}
			}
			diagnosticCollection.set(document.uri, diagnostics);
			//console.log("diagnostic count ", diagnostics.length, " ", document.uri.fsPath);
			resolve();
		}, error => {
			reject(error);
		});
	});
}

function getDiagnostic(document: TextDocument, result: Object, moduleName: string, source: SourceRange): Diagnostic {
	let deps = ['dependencies', 'devDependencies'];
	let diagnostic = null;

	deps.forEach(each => {
		if (result[each] && result[each][moduleName]) {
			if (result[each][moduleName]['missing'] === true) {
				let range = new Range(document.positionAt(source.name.offset), document.positionAt(source.name.offset + source.name.length));
				diagnostic = new Diagnostic(range, `[npm] Module '${moduleName}' is not installed`, DiagnosticSeverity.Warning);
			}
			if (result[each][moduleName]['invalid'] === true) {
				let range = new Range(document.positionAt(source.version.offset), document.positionAt(source.version.offset + source.version.length));
				diagnostic = new Diagnostic(range, `[npm] Module '${moduleName}' the installed version is invalid`, DiagnosticSeverity.Warning);
			}
		}
	});
	return diagnostic;
}

function anyModuleErrors(result: any): boolean {
	let problems: string[] = result['problems'];
	let errorCount = 0;
	if (problems) {
		problems.forEach(each => {
			if (each.startsWith('missing:') || each.startsWith('invalid:')) {
				errorCount++;
			}
		});
	}
	return errorCount > 0;
}

function collectDefinedDependencies(deps: Object, node: Node) {
	node.children.forEach(child => {
		if (child.type === 'property' && child.children.length === 2) {
			let dependencyName = child.children[0];
			let version = child.children[1];
			deps[dependencyName.value] = {
				name: {
					offset: dependencyName.offset,
					length: dependencyName.length
				},
				version: {
					offset: version.offset,
					length: version.length
				}
			};
		}
	});
}

function isDependency(value: string) {
	return value === 'dependencies' || value === 'devDependencies';
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
				let script = this.scriptName;
				// quote the script name, when it contains white space
				if (/\s/g.test(script)) {
					script = `"${script}"`;
				}
				let command = ['run-script', script];
				runNpmCommand(command, this.cwd);
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
	if (useTerminal()) {
		window.showInformationMessage('Killing is only supported when the setting "runInTerminal" is "false"');
	} else {
		let items: ProcessItem[] = [];

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
		} catch (e) {
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

function runNpmCommand(args: string[], cwd?: string, alwaysRunInputWindow = false): void {
	if (runSilent()) {
		args.push('--silent');
	}
	workspace.saveAll().then(() => {
		if (!cwd) {
			cwd = workspace.rootPath;
		}

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

function getInstalledModules(): Promise<Object> {
	return new Promise((resolve, reject) => {
		let cmd = getNpmBin() + ' ' + 'ls --depth 0 --json';
		let jsonResult = '';
		let errors = '';

		let p = cp.exec(cmd, { cwd: workspace.rootPath, env: process.env }, (error: Error, stdout: string, stderr: string) => {
			reject(error);
		});

		p.stderr.on('data', (chunk: string) => errors += chunk);
		p.stdout.on('data', (chunk: string) => jsonResult += chunk);
		p.on('exit', (code, signal) => {
			let resp = '';
			try {
				resp = JSON.parse(jsonResult);
				resolve(resp);
			} catch (e) {
				reject(e);
			}
		});
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

		if (signal === 'SIGTERM') {
			outputChannel.appendLine('Successfully killed process');
			outputChannel.appendLine('-----------------------');
			outputChannel.appendLine('');
		} else {
			outputChannel.appendLine('-----------------------');
			outputChannel.appendLine('');
		}
		validateAllDocuments();
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

