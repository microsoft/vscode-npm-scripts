# Node npm

![vscode version](https://vsmarketplacebadge.apphb.com/version/eg2.vscode-npm-script.svg)
![number of installs](https://vsmarketplacebadge.apphb.com/installs/eg2.vscode-npm-script.svg)
![average user rating](https://vsmarketplacebadge.apphb.com/rating/eg2.vscode-npm-script.svg)
![license](https://img.shields.io/github/license/microsoft/vscode-npm-scripts.svg)

This extension supports running npm scripts defined in the `package.json` file.

**Notice** support for running npm scripts is now provided by VS Code and this extension should no longer be needed. You can run npm scripts as tasks using [task auto detection](https://code.visualstudio.com/Docs/editor/tasks#_task-autodetection) or from the [npm scripts explorer](https://code.visualstudio.com/docs/getstarted/tips-and-tricks#_run-npm-scripts-as-tasks-from-the-explorer).

## Commands

Commands for running scripts are available the `npm` category.

- Run a script (`npm run-script`) defined in the `package.json` by picking a script
  defined in the `scripts` section of the `package.json`.
- Rerun the last npm script you have executed using this extension.
- Run npm install, also available in the context menu of the explorer when the `package.json` file
- Terminate a running script

The scripts can be run either in the integrated terminal or an output window.

## Touch bar

Support for Macbook Pro touch bar. You can run the following commands:

- npm install
- npm start
- npm test
- npm build

![touch bar support](images/touchbar-support.png)

## Settings

- `npm.runInTerminal` defines whether the command is run
  in a terminal window or whether the output form the command is shown in the `Output` window. The default is to show the output in the terminal.
- `npm.includeDirectories` define additional directories that include a `package.json`.
- `npm.useRootDirectory` define whether the root directory of the workspace should be ignored, the default is `false`.
- `npm.runSilent` run npm commands with the `--silent` option, the default is `false`.
- `npm.bin` custom npm bin name, the default is `npm`.
- `npm.enableTouchbar` Enable the npm scripts on macOS touchbar.
- `npm.oldKeybindings.enable` Enable the original npm keybindings that start with `cmd/ctrl R`

### Example

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

This extension originally defined a chording keyboard shortcut for the `R` key. This has resulted in conflicts with the keybindings provided by VS Code and has caused frustration. To avoid these conflicts the keybindings have been changed to use the existing chording shortcut starting with the `K` key. The following table shows the default key bindings that can always be changed, see the [customization](https://code.visualstudio.com/docs/customization/keybindings) documentation.

| Command     | Old         | New       |
| ----------- | ----------- |-----------|
| Rerun last script | `CMD+R R` | `CMD+K L` |
| Select a script to run | `CMD+R SHIFT+R` | `CMD+K SHIFT+R` |
| Terminate the running script | `CMD+R SHIFT+X` | `CMD+K SHIFT+X` |
| Run the test script | `CMD+R T` | `CMD+K T` |

If you prefer the old keybindings starting with `R` you can define the setting `npm.oldKeybindings.enable` to `true`.

[vs-url]: https://marketplace.visualstudio.com/items?itemName=eg2.vscode-npm-script
[vs-image]: https://vsmarketplacebadge.apphb.com/version/eg2.vscode-npm-script.svg
[install-url]: https://vsmarketplacebadge.apphb.com/installs/eg2.vscode-npm-script.svg
[rate-url]: https://vsmarketplacebadge.apphb.com/rating/eg2.vscode-npm-script.svg
[license-url]: https://img.shields.io/github/license/microsoft/vscode-npm-scripts.svg
