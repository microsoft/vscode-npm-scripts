import * as path from 'path';
import * as fs from 'fs';
import { satisfies } from 'semver';
import { Glob } from 'glob';

export async function readInstalledModules(cwd: string) {
	const { dependencies: prod = {}, devDependencies: dev = {} } =
		JSON.parse(
			fs.readFileSync(path.join(cwd, 'package.json')).toString('utf8'));
	const wantedDependencies = Object.assign(Object.create(null), prod, dev);
	const reports = new Array();

	return new Promise((resolve, reject) => {
		new Glob('node_modules/{*,@*/*}/package.json', { cwd, absolute: true })
			.on('error', reject)
			.on('match', (match: string) => reports.push(makeReport(match)))
			.on('end', () => resolve(merge()))
	})

	async function makeReport(pkgJson: string) {
		let invalid, extraneous;
		const json = fs.readFileSync(pkgJson).toString('utf8');
		const { name, version, _requiredBy: dependants } = JSON.parse(json);
		const requested = wantedDependencies[name];

		let [hasDirect, hasTransitive] = [false, false];
		for (const dep of dependants) {
			const isDirect = dep.length === 1 || dep.charAt(0) === '#';
			hasDirect = hasDirect || isDirect;
			hasTransitive = hasTransitive || !isDirect;
			if (hasTransitive && hasDirect) {
				break;
			}
		}

		if (hasDirect) {
			invalid = requested && !satisfies(version, requested);
			extraneous = !requested && !hasTransitive
		}

		return { [name]: { version, invalid, extraneous, missing: false } }
	}

	async function merge() {
		const problems = [];
		const missing = Array.from(Object.keys(wantedDependencies)).reduce(
			(all, one) => Object.assign({ [one]: { missing: true } }, all), {})
		const dependencies = (await Promise.all(reports)).reduce(
			(all, one) => Object.assign(all, one), missing)

		for (const name in dependencies) {
			if (dependencies.hasOwnProperty(name)) {
				const report = dependencies[name];
				switch (true) {
					case report.missing: problems.push('missing:'); break
					case report.invalid: problems.push('invalid:'); break
					case report.extraneous: problems.push('extraneous:'); break
				}
			}
		}

		return { problems, dependencies, invalid: false } // TODO: When invalid???
	}
}