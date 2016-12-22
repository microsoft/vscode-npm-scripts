Each use case assumes that project from this directory is running.

npm Test template:
------------------
Steps:
1. Press F1.
2. Type: {typed}.
3. Press Enter.
4. There should be 3 visible entries:
  - All
  - folder1: test
  - folder2: test


npm Run script template:
------------------
Steps:
1. Press F1.
2. Type: {typed}.
3. Press Enter.
4. There should be 3 visible entries:
  - folder1: test
  - folder1: folder1-shell
  - folder2: test
  - folder2: folder2-shell


Use case 1:
----------
Steps:
1. Follow steps from "npm Test template" with typed = "npm run test".
2. Choose All.

Expected:
Based on npm configuration output will be different, but terminal should return two npm configuration values.
- Value from "npm config get tag" (For example "latest").
- Value from "npm config get node-version" (For example "6.9.1.");


Use case 2:
----------
Steps:
1. Follow steps from "npm Test template" with typed = "npm run test".
2. Choose "folder1: test".

Expected:
Based on npm configuration output will be different, but terminal should return value from "npm config get tag".
For example: latest

Use case 3:
----------
Steps:
1. Follow steps from "npm Test template" with typed = "npm run test".
2. Choose "folder2: test".

Expected:
Based on npm configuration output will be different, but terminal should return value from "npm config get node-version".
For example: 6.9.1

Use case 4:
-----------
1. Follow steps from "npm Run script template" with typed = "npm run script"
2. Choose "folder1: folder1-shell"

Expected:
Based on npm configuration output will be different, but terminal should return value from "npm config get shell".
For example: /bin/bash
