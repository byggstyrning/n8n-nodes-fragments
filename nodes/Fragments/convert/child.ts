// The converter child process. One process per conversion: it receives a
// single job over IPC, runs @thatopen/fragments' IfcImporter (web-ifc WASM),
// writes the .frag next to the input, reports, and exits. Everything it needs
// is bundled into this file; the WASM sits in ./wasm/ beside it.
//
// It is started with an empty environment, so nothing of n8n's (encryption
// key, DB credentials) is visible to the code that parses untrusted IFC.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IfcImporter } from '@thatopen/fragments';
import type { ChildMessage, ConvertJob } from './protocol';

const WASM_DIR = join(__dirname, 'wasm') + '/';

function send(message: ChildMessage): Promise<void> {
	return new Promise((resolve) => {
		if (!process.send) return resolve();
		process.send(message, () => resolve());
	});
}

async function convert(job: ConvertJob): Promise<ChildMessage> {
	const input = await readFile(job.inputPath);
	const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

	const importer = new IfcImporter();
	importer.wasm = { absolute: true, path: WASM_DIR };
	// The typings say number, but null is IfcImporter's documented "no cutoff".
	importer.distanceThreshold = job.distanceThreshold as number;

	const started = Date.now();
	const frag = await importer.process({ bytes, id: job.modelId });
	const convertMs = Date.now() - started;

	await writeFile(job.outputPath, frag);
	return { type: 'done', ifcBytes: bytes.byteLength, fragBytes: frag.byteLength, convertMs };
}

if (!process.send) {
	process.stderr.write('converter.js must be started by the Fragments node (child_process.fork)\n');
	process.exit(2);
}

process.once('message', (job: ConvertJob) => {
	convert(job)
		.catch((error: unknown): ChildMessage => ({
			type: 'error',
			message: error instanceof Error ? error.message : String(error),
		}))
		.then(send)
		.finally(() => process.exit(0));
});
