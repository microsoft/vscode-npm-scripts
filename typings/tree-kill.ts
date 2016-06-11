declare module '~tree-kill/index' {
	/**
	 * Kill all processes in the process tree, including the root process.
	 */

	interface IKill {
		(processId: number, signal?: string, callback?: (err: any) => any): void;
	}

	const kill: IKill;

	export = kill;
}
declare module 'tree-kill/index' {
	import main = require('~tree-kill/index');
	export = main;
}

declare module 'tree-kill' {
	import main = require('~tree-kill/index');
	export = main;
}
