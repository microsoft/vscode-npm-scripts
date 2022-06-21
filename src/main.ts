import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import {
	window, commands, workspace, languages, OutputChannel, ExtensionContext, ViewColumn,
	QuickPickItem, Terminal, DiagnosticCollection, Diagnostic, Range, TextDocument, DiagnosticSeverity,
	CodeActionProvider, CodeActionContext, CancellationToken, Command, Uri, env
} from 'vscode';

import { runInTerminal } from 'run-in-terminal';
import { kill } from 'tree-kill';
import { parseTree, Node, ParseError } from 'jsonc-parser';
import { ThrottledDelayer } from './async';

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
	relativePath: string | undefined; // path relative to workspace root, if there is a root
	name: string;
	cmd: string;
}

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

		const cmds: Command[] = [];
		context.diagnostics.forEach(diag => {
			if (diag.source === 'npm') {
				let result = /^Module '(\S*)' is not installed/.exec(diag.message);
				if (result) {
					const moduleName = result[1];
					addFixNpmInstallModule(cmds, moduleName);
					addFixNpmInstall(cmds);
					addFixValidate(cmds);
					return;
				}
				result = /^Module '(\S*)' the installed version/.exec(diag.message);
				if (result) {
					const moduleName = result[1];
					addFixNpmInstallModule(cmds, moduleName);
					addFixValidate(cmds);
					return;
				}
				result = /^Module '(\S*)' is extraneous/.exec(diag.message);
				if (result) {
					const moduleName = result[1];
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
let terminal: Terminal | null = null;
let lastScript: Script | null = null;
let diagnosticCollection: DiagnosticCollection | null = null;
let delayer: ThrottledDelayer<void> | null = null;

export function activate(context: ExtensionContext) {
	registerCommands(context);

	diagnosticCollection = languages.createDiagnosticCollection('npm-script-runner');
	context.subscriptions.push(diagnosticCollection);

	workspace.onDidChangeConfiguration(_event => loadConfiguration(context), null, context.subscriptions);
	loadConfiguration(context);


	outputChannel = window.createOutputChannel('npm');
	context.subscriptions.push(outputChannel);

	window.onDidCloseTerminal((closedTerminal) => {
		if (terminal === closedTerminal) {
			terminal = null;
		}
	});

	context.subscriptions.push(languages.registerCodeActionsProvider({ language: 'json', scheme: 'file' }, new NpmCodeActionProvider()));

	showKeybindingWarning(context);
}

async function showKeybindingWarning(context: ExtensionContext) {
	context.globalState?.setKeysForSync([
		'keyBindingWarningShown'
	]);
	const gotIt = "OK, Got It";
	const learnMore = "Learn More";

	const warningShown = context.globalState.get<boolean>('keyBindingWarningShown');
	if (!warningShown) {
		const result = await window.showWarningMessage("The key bindings of the npm-scripts extension have changed!", learnMore, gotIt);
		if (result === gotIt) {
			context.globalState.update('keyBindingWarningShown', true);
		} else if (result === learnMore) {
			env.openExternal(Uri.parse('https://github.com/microsoft/vscode-npm-scripts#keyboard-shortcuts'));
		}
	}
}

export function deactivate() {
	if (terminal) {
		terminal.dispose();
	}
}

function clearDiagnosticCollection() {
	if (diagnosticCollection) {
		diagnosticCollection.clear();
	}
}

function isValidationEnabled(document: TextDocument) {
	const section = workspace.getConfiguration('npm', document.uri);
	if (section) {
		return section.get<boolean>('validate.enable', true);
	}
	return false;
}

function loadConfiguration(context: ExtensionContext): void {

	clearDiagnosticCollection();

	workspace.onDidSaveTextDocument(document => {
		if (isValidationEnabled(document)) {
			validateDocument(document);
		}
	}, null, context.subscriptions);
	window.onDidChangeActiveTextEditor(editor => {
		if (editor && editor.document && isValidationEnabled(editor.document)) {
			validateDocument(editor.document);
		}
	}, null, context.subscriptions);

	// remove markers on close
	workspace.onDidCloseTextDocument(_document => {
		clearDiagnosticCollection();
	}, null, context.subscriptions);

	// workaround for onDidOpenTextDocument
	// workspace.onDidOpenTextDocument(document => {
	// 	console.log("onDidOpenTextDocument ", document.fileName);
	// 	validateDocument(document);
	// }, null, context.subscriptions);
	validateAllDocuments();
}

async function validateDocument(document: TextDocument) {
	//console.log('validateDocument ', document.fileName);

	// do not validate yarn managed node_modules
	if (!isValidationEnabled(document) || await isYarnManaged(document)) {
		clearDiagnosticCollection();
		return;
	}
	if (!isPackageJson(document)) {
		return;
	}
	// Iterate over the defined package directories to check
	// if the currently opened `package.json` is one that is included in the `includedDirectories` setting.
	const found = getAllIncludedDirectories().find(each => path.dirname(document.fileName) === each);
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

async function isYarnManaged(document: TextDocument): Promise<boolean> {
	return new Promise<boolean>((resolve, _reject) => {
		const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
		if (workspaceFolder) {
			const root = workspaceFolder.uri.scheme === 'file'? workspaceFolder.uri.fsPath : undefined;
			if (!root) {
				return resolve(false);
			}
			fs.stat(path.join(root, 'yarn.lock'), (err, _stat) => {
				return resolve(err === null);
			});
		}
	});
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
		commands.registerCommand('npm-script.validate', validateAllDocuments),
		commands.registerCommand('npm-script.terminate-script', terminateScript)
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
	runNpmCommandInPackages(['build'], true);
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

async function doValidate(document: TextDocument) {
	let report = null;

	let documentWasClosed = false; // track whether the document was closed while getInstalledModules/'npm ls' runs
	const listener = workspace.onDidCloseTextDocument(doc => {
		if (doc.uri === document.uri) {
			documentWasClosed = true;
		}
	});

	try {
		report = await getInstalledModules(path.dirname(document.fileName));
	} catch (e) {
		listener.dispose();
		return;
	}
	try {
		clearDiagnosticCollection();

		if (report.invalid && report.invalid === true) {
			return;
		}
		if (!anyModuleErrors(report)) {
			return;
		}
		if (documentWasClosed || !document.getText()) {
			return;
		}
		const sourceRanges = parseSourceRanges(document.getText());
		const dependencies = report.dependencies;
		if (!dependencies) {
			return;
		}
		const diagnostics: Diagnostic[] = [];
		for (const moduleName in dependencies) {
			if (dependencies.hasOwnProperty(moduleName)) {
				const diagnostic = getDiagnostic(document, report, moduleName, sourceRanges);
				if (diagnostic) {
					diagnostic.source = 'npm';
					diagnostics.push(diagnostic);
				}
			}
		}
		//console.log("diagnostic count ", diagnostics.length, " ", document.uri.fsPath);
		diagnosticCollection!.set(document.uri, diagnostics);
	} catch (e) {
		window.showInformationMessage(`[npm-script-runner] Cannot validate the package.json ` + e);
		console.log(`npm-script-runner: 'error while validating package.json stacktrace: ${e.stack}`);
	}
}

function parseSourceRanges(text: string): SourceRanges {
	const definedDependencies: DependencySourceRanges = {};
	const properties: PropertySourceRanges = {};
	const errors: ParseError[] = [];
	const node = parseTree(text, errors);

	if (node.children) {
		node.children.forEach(child => {
			const children = child.children;
			if (children) {
				const property = children[0];
				properties[property.value] = {
					name: {
						offset: property.offset,
						length: property.length
					}
				};
				if (children && children.length === 2 && isDependency(children[0].value)) {
					collectDefinedDependencies(definedDependencies, children[1]);
				}
			}
		});
	}
	return {
		dependencies: definedDependencies,
		properties: properties
	};
}

function getDiagnostic(document: TextDocument, report: NpmListReport, moduleName: string, ranges: SourceRanges): Diagnostic | null {
	let diagnostic = null;

	// npm list only reports errors against 'dependencies' and not against 'devDependencies'
	if (report.dependencies && report.dependencies[moduleName]) {
		if (report.dependencies[moduleName]['missing'] === true) {
			if (ranges.dependencies[moduleName]) {
				const source = ranges.dependencies[moduleName].name;
				const range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
				diagnostic = new Diagnostic(range, `Module '${moduleName}' is not installed`, DiagnosticSeverity.Warning);
			} else {
				console.log(`[npm-script] Could not locate "missing" dependency '${moduleName}' in package.json`);
			}
		}
		else if (report.dependencies[moduleName]['invalid'] === true) {
			if (ranges.dependencies[moduleName]) {
				const source = ranges.dependencies[moduleName].version;
				const installedVersion = report.dependencies[moduleName]['version'];
				const range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
				const message = installedVersion ?
					`Module '${moduleName}' the installed version '${installedVersion}' is invalid` :
					`Module '${moduleName}' the installed version is invalid or has errors`;
				diagnostic = new Diagnostic(range, message, DiagnosticSeverity.Warning);
			} else {
				console.log(`[npm-script] Could not locate "invalid" dependency '${moduleName}' in package.json`);
			}
		}
		else if (report.dependencies[moduleName]['extraneous'] === true) {
			const source = findAttributeRange(ranges);
			const range = new Range(document.positionAt(source.offset), document.positionAt(source.offset + source.length));
			diagnostic = new Diagnostic(range, `Module '${moduleName}' is extraneous`, DiagnosticSeverity.Warning);
		}
	}
	return diagnostic;
}

function findAttributeRange(ranges: SourceRanges): { offset: number; length: number } {
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
	const problems: string[] | undefined = report['problems'];
	if (problems) {
		return problems.find(each => {
			return each.startsWith('missing:') || each.startsWith('invalid:') || each.startsWith('extraneous:');
		}) !== undefined;
	}
	return false;
}

function collectDefinedDependencies(dependencies: DependencySourceRanges, node: Node | undefined) {
	if (!node || !node.children) {
		return;
	}
	node.children.forEach(child => {
		if (child.type === 'property' && child.children && child.children.length === 2) {
			const dependencyName = child.children[0];
			const version = child.children[1];
			dependencies[dependencyName.value] = {
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

async function getInstalledModules(package_dir: string): Promise<NpmListReport> {
	return new Promise<NpmListReport>((resolve, reject) => {
		const cmd = getNpmBin() + ' ' + 'ls --depth 0 --json';
		let jsonResult = '';
		let errors = '';

		const p = cp.exec(cmd, { cwd: package_dir, env: process.env });

		p.stderr.on('data', (chunk: string) => errors += chunk);
		p.stdout.on('data', (chunk: string) => jsonResult += chunk);
		p.on('close', (_code: number, _signal: string) => {
			try {
				const resp: NpmListReport = JSON.parse(jsonResult);
				resolve(resp);
			} catch (e) {
				reject(e);
			}
		});
	});
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
		validateAllDocuments();
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
