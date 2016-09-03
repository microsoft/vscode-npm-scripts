# Node npm Script Running for Visual Studio Code

This extension supports running npm scripts defined in the `package.json` file.

## Features
- Run npm install.
- Run a script (`npm run-script`) defined in the `package.json` by picking a script
defined in the `scripts` section of the `package.json`.
- Rerun the last npm script you have executed using this extension.
- Terminate a running script

## Using

The commands defined by this extensions are in the `npm` category.

![command palette](images/cmds.png)

## Settings

- `npm.runInTerminal` defines whether the command is run
in a terminal window or whether the output form the command is shown in the `Output` window. The default is to show the output in the terminal.
- `npm.includeDirectories` define additional directories that include a  `package.json`.
- `npm.useRootDirectory` define whether the root directory of the workspace should be ignored, the default is `false`.
- `npmRunSilent` run npm commands with the `--silent` option, the default is `false`.

##### Example
```javascript
{
	"npm.runInTerminal": false,
	"npm.includeDirectories": [
		"subdir1/path",
		"subdir2/path"
	]
}
```

## Keyboard Shortcuts

The extension defines a chording keyboard shortcut for the `R` key. As a consequence an existing keybinding for `R` is not executed immediately. If this is not desired, then please bind another key for these commands, see the [customization](https://code.visualstudio.com/docs/customization/keybindings) documentation.

## Release Notes

- 0.0.20 when commands are run in the terminal, then the **integrated terminal** is used.
- 0.0.16 added `npm install ` to the context menu on `package.json` in the explorer.
- 0.0.15 added setting to run npm commands with `--silent`.
- 0.0.15 tweaks to the README so that the extension is found when searching for node.
- 0.0.14 added command to terminate a running script
- 0.0.13 save workspace before running scripts, added command to run `npm run build`
- 0.0.12 added support for `npm.useRootDirectory`
- 0.0.11 added command to run `npm test`.
- 0.0.7 adding an icon and changed the display name to 'npm Script Runner'.
- 0.0.4 the keybinding was changed from `R` to `N` to avoid conflicts with the default `workbench.action.files.newUntitledFile` command.
