// Converts each IFC twice, with the same model id: once by calling
// @thatopen/fragments' IfcImporter directly in this process (the reference),
// and once through this package's runner + bundled converter. Prints timings
// and fails unless the .frag bytes are identical.
//
//   pnpm build
//   pnpm compare a.ifc b.ifc ...

import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcImporter } from '@thatopen/fragments';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { convertIfc } = require(join(root, '.test-build/runner.cjs'));
const wasmPath = dirname(require.resolve('web-ifc')) + '/';

const files = process.argv.slice(2);
if (!files.length) {
	console.error('usage: pnpm compare <file.ifc>...');
	process.exit(2);
}

let failures = 0;
for (const file of files) {
	const id = `compare-${basename(file)}`;
	const ifc = await fs.readFile(file);

	const importer = new IfcImporter();
	importer.wasm = { absolute: true, path: wasmPath };
	importer.distanceThreshold = 100000;
	const started = Date.now();
	const reference = Buffer.from(await importer.process({ bytes: new Uint8Array(ifc), id }));
	const referenceMs = Date.now() - started;

	const result = await convertIfc({
		source: createReadStream(file),
		modelId: id,
		distanceThreshold: 100000,
		limits: { timeoutMs: 30 * 60_000, maxIfcBytes: 2 ** 31, maxMemoryMb: 16_384 },
		childPath: join(root, 'dist/nodes/Fragments/converter.js'),
	});
	const ours = await fs.readFile(result.fragPath);
	await result.cleanup();

	const same = ours.equals(reference);
	if (!same) failures++;
	console.log(
		[
			basename(file).padEnd(40),
			`${(ifc.length / 1e6).toFixed(1)} MB →`,
			`${(ours.length / 1e6).toFixed(2)} MB`,
			same ? 'IDENTICAL' : 'DIFFERENT',
			`in-process ${referenceMs} ms`,
			`node ${result.convertMs} ms (total ${result.totalMs} ms)`,
			`peak RSS ${result.peakRssMb} MB`,
		].join('  '),
	);
}
process.exit(failures ? 1 : 0);
