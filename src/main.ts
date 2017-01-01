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
import { parseTree, Node, ParseError } from 'jsonc-parser';
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
		version?: string;
		invalid?: boolean;
		extraneous?: boolean;
		missing?: boolean;
	};
}

interface NpmListReport {
	invalid?: boolean;
	problems?: string[];
	dependencies?: NpmDependencyReport;
}

interface ScriptCommandDescription {
	absolutePath: string;
	relativePath: string;
	name: string;
	cmd: string;
};

interface CommandArgument {
	fsPath: string;
}

class NpmCodeActionProvider implements CodeActionProvider {
	public provideCodeActions(document: TextDocument, _range: Range, context: CodeActionContext, _token: CancellationToken): Command[] {
		function addFixNpmInstallModule(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm install '${moduleName}'`,
				command: 'npm-script.installInOutputWindow',
				arguments: [path.dirname(document.fileName), moduleName]
			});
		}

		function addFixNpmInstall(cmds: Command[]) {
			cmds.push({
				title: `run: npm install`,
				command: 'npm-script.installInOutputWindow',
				arguments: [path.dirname(document.fileName)]
			});
		}

		function addFixValidate(cmds: Command[]) {
			cmds.push({
				title: `validate installed modules`,
				command: 'npm-script.validate',
				arguments: [path.dirname(document.fileName)]
			});
		}

		function addFixNpmUninstallModule(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm uninstall '${moduleName}'`,
				command: 'npm-script.uninstallInOutputWindow',
				arguments: [path.dirname(document.fileName), moduleName]
			});
		}

		function addFixNpmInstallModuleSave(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm install '${moduleName}' --save`,
				command: 'npm-script.installInOutputWindow',
				arguments: [path.dirname(document.fileName), moduleName, '--save']
			});
		}

		function addFixNpmInstallModuleSaveDev(cmds: Command[], moduleName: string) {
			cmds.push({
				title: `run: npm install '${moduleName}' --save-dev`,
				command: 'npm-script.installInOutputWindow',
				arguments: [path.dirname(document.fileName), moduleName, '--save-dev']
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
let diagnosticCollection: DiagnosticCollection = null;
let delayer: ThrottledDelayer<void> = null;
let validationEnabled = true;

export function activate(context: ExtensionContext) {
	registerCommands(context);

	diagnosticCollection = languages.createDiagnosticCollection('npm-script-runner');
	context.subscriptions.push(diagnosticCollection);

	workspace.onDidChangeConfiguration(_event => loadConfiguration(context), null, context.subscriptions);
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
	if (!isPackageJson(document)) {
		return;
	}
	// Iterate over the defined package directories to check
	// if the currently opened `package.json` is one that is included in the `includedDirectories` setting.
	let found = getIncludedDirectories().find(each => path.dirname(document.fileName) === each);
	if (!found) {
		return;
	}
	if (!delayer) {
		delayer = new ThrottledDelayer<void>(200);
	}
	delayer.trigger(() => doValidate(document));
}

function isPackageJson(document: TextDocument) {
	return document && path.basename(document.fileName) === 'package.json';
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

function createAllCommand(scriptList: Script[], isScriptCommand: boolean): Script {
	return {
		label: "All",
		description: "Run all " + (isScriptCommand ? "scripts" : "commands") + " listed below",
		scriptName: "Dummy",
		cwd: null,
		execute(this: Script) {
			for (let s of scriptList) {
				// check for null ``cwd to prevent calling the function by itself.
				if (s.cwd) {
					s.execute();
				}
			}
		}
	};
}

function pickScriptToExecute(descriptions: ScriptCommandDescription[], command: string[], allowAll = false, alwaysRunInputWindow = false) {
	let scriptList: Script[] = [];
	let isScriptCommand = command[0] === 'run-script';

	if (allowAll && descriptions.length > 1) {
		scriptList.push(createAllCommand(scriptList, isScriptCommand));
	}
	for (let s of descriptions) {
		let label = s.name;
		if (s.relativePath) {
			label = `${s.relativePath}: ${label}`;
		}
		scriptList.push({
			label: label,
			description: s.cmd,
			scriptName: s.name,
			cwd: s.absolutePath,
			execute(this:Script) {
				let script = this.scriptName;
				// quote the script name, when it contains white space
				if (/\s/g.test(script)) {
					script = `"${script}"`;
				}
				// Create copy of command to ensure that we always get the correct command when the script is rerun.
				let cmd = Array.from(command);
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
			window.showErrorMessage(`Failed to find handler for "${command[0]}" commnd`);
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
	let descriptions = commandsDescriptions(command, dirs);
	pickScriptToExecute(descriptions, command, allowAll, alwaysRunInputWindow);
}

/**
  * Executes an npm command with it's arguments.
  * @param cmd Command name.
  * @param args Array of command arguments, they will be passed to the npm command.
  *  Note: The first argument must be the path to the directory where the command will be executed.
  */
function runNpmCommandWithArguments(cmd:string, ...args: any[]) {
	let cmdArgs = [].slice.call(args);
	let dir = cmdArgs.shift();
	cmdArgs.unshift(cmd);
	runNpmCommand(cmdArgs, dir);
}

function runNpmInstall(arg: CommandArgument) {
	let dirs = [];
	// Is the command executed from the context menu?
	if (arg && arg.fsPath) {
		dirs.push(path.dirname(arg.fsPath));
	} else {
		dirs = getIncludedDirectories();
	}
	runNpmCommandInPackages(['install'], true, false, dirs);
}

function runNpmInstallInOutputWindow() {
	runNpmCommandWithArguments('install', arguments);
}

function runNpmUninstallInOutputWindow() {
	runNpmCommandWithArguments('uninstall', arguments);
}

function runNpmTest() {
	runNpmCommandInPackages(['run-script', 'test'], true);
}

function runNpmStart() {
	runNpmCommandInPackages(['start'], true);
}

function runNpmBuild() {
	runNpmCommandInPackages(['build'], true);
}

function runNpmScript(): void {
	runNpmCommandInPackages(['run-script'], false);
};

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
 *    - with scripts that matche the name.
 */
function commandDescriptionsInPackage(param: string[], packagePath: string, descriptions: ScriptCommandDescription[]) {
	var absolutePath = packagePath;
	var relativePath = absolutePath.substring(workspace.rootPath.length + 1);
	let cmd = param[0];
	let name = param[1];

	if (cmd === 'run-script') {
		try {
			let fileName = path.join(packagePath, 'package.json');
			let contents = fs.readFileSync(fileName).toString();
			let json = JSON.parse(contents);
			if (json.scripts) {
				var jsonScripts = json.scripts;
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

function commandsDescriptions(command: string[], dirs?: string[]): ScriptCommandDescription[] {
	if (!dirs) {
		dirs = getIncludedDirectories();
	}
	let descriptions:ScriptCommandDescription[] = [];
	dirs.forEach(dir => commandDescriptionsInPackage(command, dir, descriptions));
	return descriptions;
}

async function doValidate(document: TextDocument) {
	let report = null;

	try {
		report = await getInstalledModules(path.dirname(document.fileName));
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
		console.log(`npm-script-runner: 'error while validating package.json stacktrace: ${e.stack}`);
	}
}

function parseSourceRanges(text: string): SourceRanges {
	let definedDependencies: DependencySourceRanges = {};
	let properties: PropertySourceRanges = {};
	let errors:ParseError[] = [];
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

function getDiagnostic(document: TextDocument, report: NpmListReport, moduleName: string, ranges: SourceRanges): Diagnostic {
	let diagnostic = null;

	// npm list only reports errors against 'dependencies' and not against 'devDependencies'
	if (report.dependencies && report.dependencies[moduleName]) {
		if (report.dependencies[moduleName]['missing'] === true) {
			if (ranges.dependencies[moduleName]) {
				let source = ranges.dependencies[moduleName].name;
				let range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
				diagnostic = new Diagnostic(range, `Module '${moduleName}' is not installed`, DiagnosticSeverity.Warning);
			} else {
				console.log(`[npm-script] Could not locate "missing" dependency '${moduleName}' in package.json`);
			}
		}
		else if (report.dependencies[moduleName]['invalid'] === true) {
			if (ranges.dependencies[moduleName]) {
				let source = ranges.dependencies[moduleName].version;
				let installedVersion = report.dependencies[moduleName]['version'];
				let range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
				let message = installedVersion ?
					`Module '${moduleName}' the installed version '${installedVersion}' is invalid` :
					`Module '${moduleName}' the installed version is invalid or has errors`;
				diagnostic = new Diagnostic(range, message, DiagnosticSeverity.Warning);
			} else {
				console.log(`[npm-script] Could not locate "invalid" dependency '${moduleName}' in package.json`);
			}
		}
		else if (report.dependencies[moduleName]['extraneous'] === true) {
			let source = findAttributeRange(ranges);
			let range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
			diagnostic = new Diagnostic(range, `Module '${moduleName}' is extraneous`, DiagnosticSeverity.Warning);
		}
	}
	return diagnostic;
}

function findAttributeRange(ranges: SourceRanges): { offset: number, length: number } {
	let source = null;
	if (ranges.properties['dependencies']) {
		source = ranges.properties['dependencies'].name;
	} else if (ranges.properties['devDependencies']) {
		source = ranges.properties['devDependencies'].name;
	} else if (ranges.properties['name']) {
		source = ranges.properties['name'].name;
	} else {
		// no attribute found in the package.json to attach the diagnostic, therefore just attach the diagnostic to the top of the file
		source = { offset: 0, length: 1 };
	}
	return source;
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

async function getInstalledModules(package_dir?: string): Promise<NpmListReport> {
	return new Promise<NpmListReport>((resolve, reject) => {
		if (!package_dir) {
			package_dir = workspace.rootPath;
		}
		let cmd = getNpmBin() + ' ' + 'ls --depth 0 --json';
		let jsonResult = '';
		let errors = '';

		let p = cp.exec(cmd, { cwd: package_dir, env: process.env });

		p.stderr.on('data', (chunk: string) => errors += chunk);
		p.stdout.on('data', (chunk: string) => jsonResult += chunk);
		p.on('close', (_code: number, _signal: string) => {
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
		validateAllDocuments();
	});

	showNpmOutput();
}

function runCommandInTerminal(args: string[], cwd: string): void {
	runInTerminal(getNpmBin(), args, { cwd: cwd, env: process.env });
}

function runCommandInIntegratedTerminal(args: string[], cwd: string): void {
	let cmd_args = Array.from(args);
	if (!terminal) {
		terminal = window.createTerminal('npm');
	}
	terminal.show();
	if (cwd) {
		terminal.sendText(['cd', cwd].join(' '));
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
