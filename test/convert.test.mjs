// The real converter (dist/nodes/Fragments/converter.js) on a real IFC.
// Needs `pnpm build`. Uses the hand-written fixture by default; set
// FRAGMENTS_TEST_IFC to run the same checks on another model.

import assert from 'node:assert/strict';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { ByteBuffer } from 'flatbuffers';
import { Model } from '@thatopen/fragments';

const require = createRequire(import.meta.url);
const { convertIfc } = require('../.test-build/runner.cjs');
const childPath = new URL('../dist/nodes/Fragments/converter.js', import.meta.url).pathname;
const fixture = new URL('./fixtures/wall-and-slab.ifc', import.meta.url).pathname;
const ifc = process.env.FRAGMENTS_TEST_IFC ?? fixture;

const limits = { timeoutMs: 120_000, maxIfcBytes: 2 ** 30, maxMemoryMb: 3072 };

async function convert(source, modelId) {
	const result = await convertIfc({ source, modelId, distanceThreshold: 100000, limits, childPath });
	try {
		return { ...result, bytes: await fs.readFile(result.fragPath) };
	} finally {
		await result.cleanup();
	}
}

test('produces a .frag that parses as a Fragments model', async () => {
	const { bytes, fragBytes } = await convert(createReadStream(ifc), 'test-model');
	assert.equal(bytes.length, fragBytes);
	const model = Model.getRootAsModel(new ByteBuffer(new Uint8Array(inflateSync(bytes))));
	assert.equal(model.guid(), 'test-model');
	assert.ok(model.guidsLength() > 0, 'no GUIDs');
	assert.ok(model.localIdsLength() > 0, 'no local ids');
	assert.ok(model.meshes()?.samplesLength() > 0, 'no geometry samples');
	assert.ok(model.spatialStructure(), 'no spatial structure');
	if (ifc === fixture) {
		const guids = Array.from({ length: model.guidsLength() }, (_, i) => model.guids(i));
		assert.ok(guids.includes('1Hi0Jk1Lm2No3Pq4Rs5Tu6'), 'wall GUID missing');
		assert.ok(guids.includes('2Ij1Kl2Mn3Op4Qr5St6Uv7'), 'slab GUID missing');
		assert.equal(model.meshes()?.samplesLength(), 2, 'expected one sample each for the wall and the slab');
	}
});

test('same IFC and model id give identical bytes', async () => {
	const a = await convert(createReadStream(ifc), 'stable-id');
	const b = await convert(createReadStream(ifc), 'stable-id');
	assert.ok(a.bytes.equals(b.bytes));
});

test('no model id gives a random GUID', async () => {
	const { bytes } = await convert(createReadStream(ifc), undefined);
	const guid = Model.getRootAsModel(new ByteBuffer(new Uint8Array(inflateSync(bytes)))).guid();
	assert.match(guid, /^[0-9a-f-]{36}$/);
});

test('a broken STEP file fails with the converter error, not a crash', async () => {
	const broken = Readable.from([Buffer.from('ISO-10303-21;\nHEADER;\nnonsense\n')]);
	await assert.rejects(convert(broken, 'x'), (error) => {
		assert.ok(['failed', 'crashed'].includes(error.code), `${error.code}: ${error.message}`);
		return true;
	});
});
