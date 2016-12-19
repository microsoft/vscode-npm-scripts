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
}

interface SourceRangeWithVersion extends SourceRange {
	version: {
		offset: number;
		length: number;
	};
}

interface DependencySourceRanges {
	[dependency: string]: SourceRangeWithVersion;
}

interface PropertySourceRanges {
	[dependency: string]: SourceRange;
}

interface SourceRanges {
	properties: PropertySourceRanges;
	dependencies: DependencySourceRanges;
}

interface NpmDependencyReport {
	[dependency: string]: {
		version: string;
		invalid?: boolean;
		extraneous?: boolean;
		missing?: boolean;
	};
}

interface NpmListReport {
	invalid: boolean;
	problems: string[];
	dependencies: NpmDependencyReport;
}

class NpmCodeActionProvider implements CodeActionProvider {
	public provideCodeActions(document: TextDocument, range: Range, context: CodeActionContext, token: CancellationToken): Command[] {
		function addFixNpmInstallModule(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm install '${moduleName}'`,
				command: 'npm-script.installInOutputWindow',
				arguments: [moduleName]
			});
		}

		function addFixNpmInstall(cmds: Command[]) {
			cmds.push({
				title: `run: npm install`,
				command: 'npm-script.installInOutputWindow',
				arguments: []
			});
		}

		function addFixValidate(cmds: Command[]) {
			cmds.push({
				title: `validate installed modules`,
				command: 'npm-script.validate',
				arguments: []
			});
		}

		function addFixNpmUninstallModule(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm uninstall '${moduleName}'`,
				command: 'npm-script.uninstallInOutputWindow',
				arguments: [moduleName]
			});
		}

		function addFixNpmInstallModuleSave(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm install '${moduleName}' --save`,
				command: 'npm-script.installInOutputWindow',
				arguments: [moduleName, '--save']
			});
		}

		function addFixNpmInstallModuleSaveDev(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm install '${moduleName}' --save-dev`,
				command: 'npm-script.installInOutputWindow',
				arguments: [moduleName, '--save-dev']
			});
		}

		let cmds: Command[] = [];
		context.diagnostics.forEach(diag => {
			if (diag.source === 'npm') {
				let result = /^Module '(\S*)' is not installed/.exec(diag.message);
				if (result) {
					let moduleName = result[1];
					addFixNpmInstallModule(cmds, moduleName);
					addFixNpmInstall(cmds);
					addFixValidate(cmds);
					return;
				}
				result = /^Module '(\S*)' the installed version/.exec(diag.message);
				if (result) {
					let moduleName = result[1];
					addFixNpmInstallModule(cmds, moduleName);
					addFixValidate(cmds);
					return;
				}
				result = /^Module '(\S*)' is extraneous/.exec(diag.message);
				if (result) {
					let moduleName = result[1];
					addFixNpmUninstallModule(cmds, moduleName);
					addFixNpmInstallModuleSave(cmds, moduleName);
					addFixNpmInstallModuleSaveDev(cmds, moduleName);
					addFixValidate(cmds);
					return;
				}
			}
		});
		return cmds;
	}
}

const runningProcesses: Map<number, Process> = new Map();

let outputChannel: OutputChannel;
let terminal: Terminal = null;
let lastScript: Script = null;
let diagnosticCollection: DiagnosticCollection;
let delayer: ThrottledDelayer<void> = null;
let validationEnabled = true;

export function activate(context: ExtensionContext) {
	registerCommands(context);

	diagnosticCollection = languages.createDiagnosticCollection('npm-script-runner');
	context.subscriptions.push(diagnosticCollection);

	workspace.onDidChangeConfiguration(event => loadConfiguration(context), null, context.subscriptions);
	loadConfiguration(context);

	outputChannel = window.createOutputChannel('npm');
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(languages.registerCodeActionsProvider('json', new NpmCodeActionProvider()));
}

export function deactivate() {
	if (terminal) {
		terminal.dispose();
	}
}

function loadConfiguration(context: ExtensionContext): void {
	let section = workspace.getConfiguration('npm');
	if (section) {
		validationEnabled = section.get<boolean>('validate.enable', true);
	}
	diagnosticCollection.clear();

	if (validationEnabled) {
		workspace.onDidSaveTextDocument(document => {
			validateDocument(document);
		}, null, context.subscriptions);
		window.onDidChangeActiveTextEditor(editor => {
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
		validateAllDocuments();
	}
}

function validateDocument(document: TextDocument) {
	//console.log('validateDocument ', document.fileName);
	if (!validationEnabled) {
		return;
	}
	// Currently only validate the top-level package.json
	if (!isTopLevelPackageJson(document)) {
		return;
	}
	if (!delayer) {
		delayer = new ThrottledDelayer<void>(200);
	}
	delayer.trigger(() => doValidate(document));
}

function isTopLevelPackageJson(document: TextDocument) {
	if (!document || !workspace.rootPath) {
		return false;
	}
	return path.basename(document.fileName) === 'package.json' && path.dirname(document.fileName) === workspace.rootPath;
}

function validateAllDocuments() {
	// TODO: why doesn't this not work?
	//workspace.textDocuments.forEach(each => validateDocument(each));

	window.visibleTextEditors.forEach(each => {
		if (each.document) {
			validateDocument(each.document);
		}
	});
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
		commands.registerCommand('npm-script.uninstallInOutputWindow', runNpmUninstallInOutputWindow),
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

function runNpmInstallInOutputWindow(arg1, arg2) {
	let dirs = getIncludedDirectories();
	for (let dir of dirs) {
		runNpmCommand(['install', arg1, arg2], dir, true);
	}
}

function runNpmUninstallInOutputWindow(arg) {
	let dirs = getIncludedDirectories();
	for (let dir of dirs) {
		runNpmCommand(['uninstall', arg], dir, true);
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

async function doValidate(document: TextDocument) {
	let report = null;

	try {
		report = await getInstalledModules();
	}catch (e) {
		// could not run 'npm ls' do not validate the package.json
		return;
	}

	try {
		diagnosticCollection.clear();

		if (report.invalid && report.invalid === true) {
			return;
		}
		if (!anyModuleErrors(report)) {
			return;
		}

		let sourceRanges = parseSourceRanges(document.getText());
		let dependencies = report.dependencies;
		let diagnostics: Diagnostic[] = [];

		for (var moduleName in dependencies) {
			if (dependencies.hasOwnProperty(moduleName)) {
				let diagnostic = getDiagnostic(document, report, moduleName, sourceRanges);
				if (diagnostic) {
					diagnostic.source = 'npm';
					diagnostics.push(diagnostic);
				}
			}
		}
		//console.log("diagnostic count ", diagnostics.length, " ", document.uri.fsPath);
		diagnosticCollection.set(document.uri, diagnostics);
	} catch (e) {
		window.showInformationMessage(`[npm-script-runner] Cannot validate the package.json ` + e);
	}
}

function parseSourceRanges(text: string): SourceRanges {
	let definedDependencies: DependencySourceRanges = {};
	let properties: PropertySourceRanges = {};
	let errors = [];
	let node = parseTree(text, errors);

	node.children.forEach(child => {
		let children = child.children;
		let property = children[0];
		properties[property.value] = {
			name: {
				offset: property.offset,
				length: property.length
			}
		};
		if (children && children.length === 2 && isDependency(children[0].value)) {
			collectDefinedDependencies(definedDependencies, child.children[1]);
		}
	});
	return {
		dependencies: definedDependencies,
		properties: properties
	};
}

function getDiagnostic(document: TextDocument, result: Object, moduleName: string, ranges: SourceRanges): Diagnostic {
	let diagnostic = null;

	['dependencies', 'devDependencies'].forEach(each => {
		if (result[each] && result[each][moduleName]) {
			if (result[each][moduleName]['missing'] === true) {
				let source = ranges.dependencies[moduleName].name;
				let range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
				diagnostic = new Diagnostic(range, `Module '${moduleName}' is not installed`, DiagnosticSeverity.Warning);
			}
			else if (result[each][moduleName]['invalid'] === true) {
				let source = ranges.dependencies[moduleName].version;
				let installedVersion = result[each][moduleName]['version'];
				let range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
				diagnostic = new Diagnostic(range, `Module '${moduleName}' the installed version '${installedVersion}' is invalid`, DiagnosticSeverity.Warning);
			}
			else if (result[each][moduleName]['extraneous'] === true) {
				let source = null;
				if (ranges.properties['dependencies']) {
					source = ranges.properties['dependencies'].name;
				} else if (ranges.properties['devDependencies']) {
					source = ranges.properties['devDependencies'].name;
				} else if (ranges.properties['name']) {
					source = ranges.properties['name'].name;
				}
				let range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
				diagnostic = new Diagnostic(range, `Module '${moduleName}' is extraneous`, DiagnosticSeverity.Warning);
			}
		}
	});
	return diagnostic;
}

function anyModuleErrors(report: NpmListReport): boolean {
	let problems: string[] = report['problems'];
	if (problems) {
		return problems.find(each => {
			return each.startsWith('missing:') || each.startsWith('invalid:') || each.startsWith('extraneous:');
		}) !== undefined;
	}
	return false;
}

function collectDefinedDependencies(deps: DependencySourceRanges, node: Node) {
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

async function getInstalledModules(): Promise<NpmListReport> {
	return new Promise<NpmListReport>((resolve, reject) => {
		let cmd = getNpmBin() + ' ' + 'ls --depth 0 --json';
		let jsonResult = '';
		let errors = '';

		let p = cp.exec(cmd, { cwd: workspace.rootPath, env: process.env });

		p.stderr.on('data', (chunk: string) => errors += chunk);
		p.stdout.on('data', (chunk: string) => jsonResult += chunk);
		p.on('close', (code, signal) => {
			try {
				let resp: NpmListReport = JSON.parse(jsonResult);
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

