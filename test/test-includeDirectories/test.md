Each manual Test Case assumes that VS Code is opened on the folder `test/testIncludeDirectories`.

## Test Case 1:

Steps:

1. Press F1.
2. Type: `npm run test`.
3. Press Enter.
4. There should be 3 visible entries:
    - All
    - folder1: test
    - folder2: test
5. Select All.

Expected:
Based on the npm configuration, the output will be different, but the terminal should return two npm configuration values.
- `npm config get tag` (For example `latest`).
- `npm config get node-version` (For example `6.9.1`);

## Test Case 2:

Steps:
1. Press F1.
2. Type: `npm run test`.
3. Press Enter.
4. There should be 3 visible entries:
    - All
    - folder1: test
    - folder2: test
5. Choose "folder1: test".

Expected:
Based on the npm configuration the output will be different, but the terminal should return value from `npm config get tag`, e.g., `latest`.

## Test Case 3:

Steps:
1. Press F1.
2. Type: `npm run test`.
3. Press Enter.
4. There should be 3 visible entries:
    - All
    - folder1: test
    - folder2: test
5. Choose "folder2: test".

Expected:
Based on the npm configuration the output will be different, but the terminal should return the result from `npm config get node-version`, e.g., `6.9.1`.

## Test Case 4:

1. Follow steps from "npm Run script template" with typed = "npm run script"
1. Press F1.
2. Type: `npm run script`.
3. Press Enter.
4. There should be 3 visible entries:
    - folder1: test
    - folder1: folder1-shell
    - folder2: test
    - folder2: folder2-shell
5. Choose "folder1: folder1-shell"

Expected:
Based on the npm configuration the output will be different, but the terminal should return value from `npm config get shell`, e.g. `/bin/bash`.

## Test Case 5

1. Open the file `folder/package.json`

Expected:

There is a warning that the module `chalk` isn't installed.

2. Select the quick fix action shown in light bulb `npm install`
3. Use the quick fix action `npm validate`

Expected:

The warning for the missing module `chalk` no longer shows up.
