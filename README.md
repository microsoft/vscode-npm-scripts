# Npm Script Running for Visual Studio Code

This extension supports to run scripts defined in the `package.json` file.

## Features
- Run npm install.
- Run a script (`npm run-script`) defined in the `package.json` by picking a script
defined in the `scripts` section of the `package.json`.
- Rerun the last npm script you have executed using this extension.

## Using

The commands defined by this extensions are in the `npm` category.

![command palette](images/cmds.png)

## Settings

With the setting `npm.runInTerminal` you configure whether the command is run
in a terminal window or whether the output form the command is shown in the `Output` window.

## Keyboard Shortcuts

The extension defines a chording keyboard shortcut for the `R` key. As a consequence an existing keybinding for `R` is not executed immediately. If this is not desired, then please bind another key for these commands, see the [customization](https://code.visualstudio.com/docs/customization/keybindings) documentation.

## Release Notes

- 0.0.4 the keybinding was changed from `R` to `N` to avoid conflicts with the default `workbench.action.files.newUntitledFile` command. 
