# Npm Script Running for Visual Studio Code

This extension supports running scripts defined in the `package.json` file.

## Features
- Run npm install.
- Run a script (`npm run-script`) defined in the `package.json` by picking a script
defined in the `scripts` section of the `package.json`.
- Rerun the last npm script you have executed using this extension.

## Using

The commands defined by this extensions are in the `npm` category.

![command palette](images/cmds.png)

## Settings

- With the setting `npm.runInTerminal` you configure whether the command is run
in a terminal window or whether the output form the command is shown in the `Output` window.
- If you have a subdirectory in your project with its own `package.json` file you can add it to the setting `npm.includeDirectories`.
- If your root directory does not happen to contain `package.json` you can set `npm.useRootDirectory` to false to ignore the root directory.

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

- 0.0.11 added command to run `npm test`.
- 0.0.7 adding an icon and changed the display name to 'npm Script Runner'.
- 0.0.4 the keybinding was changed from `R` to `N` to avoid conflicts with the default `workbench.action.files.newUntitledFile` command.
