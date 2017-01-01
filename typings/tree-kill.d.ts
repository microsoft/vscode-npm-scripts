declare module "tree-kill" {
	export function kill(pid: number, signal?: string, callback?: (err:any)=>any):void;
}