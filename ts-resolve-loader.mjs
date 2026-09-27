// Custom ESM resolve hook so extensionless TS-style imports (e.g. `./battle`)
// resolve to their .ts file, the way tsc's moduleResolution does but Node's
// native loader does not. Needed because Showdown's source was written to be
// compiled by tsc, not run directly by Node's native TS support.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const EXTS = ['.ts', '.js', '.mjs', '/index.ts', '/index.js'];

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		if (!(specifier.startsWith('./') || specifier.startsWith('../'))) throw err;
		if (!context.parentURL) throw err;

		const parentPath = fileURLToPath(context.parentURL);
		const basePath = path.resolve(path.dirname(parentPath), specifier);

		for (const ext of EXTS) {
			const candidate = basePath + ext;
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return nextResolve(pathToFileURL(candidate).href, context);
			}
		}
		throw err;
	}
}
