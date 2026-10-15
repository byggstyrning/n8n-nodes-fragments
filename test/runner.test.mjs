// Runner behaviour against fake children: limits, failure modes, queueing,
// cleanup. Needs `pnpm build` first (uses .test-build/runner.cjs).

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { convertIfc, ConversionError } = require('../.test-build/runner.cjs');
const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

let tmpRoot;
before(async () => {
	tmpRoot = await fs.mkdtemp(join(tmpdir(), 'frag-runner-test-'));
});
after(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

const limits = { timeoutMs: 10_000, maxIfcBytes: 1024 * 1024, maxMemoryMb: 512 };

function run(child, overrides = {}) {
	return convertIfc({
		source: Readable.from([Buffer.from(overrides.body ?? 'ISO-10303-21; delay=0')]),
		distanceThreshold: 100000,
		limits,
		childPath: fixture(child),
		tmpRoot,
		...overrides,
	});
}

async function rejectsWith(promise, code) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof ConversionError, `expected ConversionError, got ${error}`);
		assert.equal(error.code, code, error.message);
		return true;
	});
}

async function tmpEntries() {
	return (await fs.readdir(tmpRoot)).filter((name) => name.startsWith('n8n-frag-'));
}

describe('convertIfc', () => {
	test('returns the child output and cleans up after cleanup()', async () => {
		const result = await run('fake-ok.cjs', { modelId: 'abc' });
		const out = JSON.parse(await fs.readFile(result.fragPath, 'utf8'));
		assert.equal(out.modelId, 'abc');
		assert.equal(out.threshold, 100000);
		assert.equal(result.ifcBytes, 'ISO-10303-21; delay=0'.length);
		assert.ok(result.totalMs >= result.convertMs);
		assert.equal(result.queuedMs >= 0, true);
		assert.equal((await tmpEntries()).length, 1, 'temp dir lives until cleanup()');
		await result.cleanup();
		assert.deepEqual(await tmpEntries(), []);
	});

	test('child gets an empty environment', async () => {
		process.env.FRAGMENTS_TEST_SECRET = 'do-not-leak';
		const result = await run('fake-ok.cjs');
		const out = JSON.parse(await fs.readFile(result.fragPath, 'utf8'));
		await result.cleanup();
		assert.ok(!out.env.includes('FRAGMENTS_TEST_SECRET'), `child saw: ${out.env.join(', ')}`);
	});

	test('reports peak RSS on Linux', { skip: process.platform !== 'linux' }, async () => {
		const result = await run('fake-ok.cjs', { body: 'ISO-10303-21; delay=300' });
		await result.cleanup();
		assert.ok(result.peakRssMb > 10, `peakRssMb=${result.peakRssMb}`);
	});

	test('refuses an oversized IFC without starting the child', async () => {
		const big = Buffer.alloc(limits.maxIfcBytes + 1, 0x41);
		await rejectsWith(run('fake-crash.cjs', { source: Readable.from([big]) }), 'too_large');
		assert.deepEqual(await tmpEntries(), []);
	});

	test('refuses an empty IFC', async () => {
		await rejectsWith(run('fake-ok.cjs', { source: Readable.from([]) }), 'empty');
	});

	test('refuses a non-IFC input without starting the child', async () => {
		await rejectsWith(run('fake-crash.cjs', { body: 'hello, not an IFC' }), 'not_ifc');
		await rejectsWith(run('fake-crash.cjs', { body: 'PK\x03\x04 zipped' }), 'not_ifc');
		assert.deepEqual(await tmpEntries(), []);
	});

	test('accepts a STEP header after a BOM or blank lines', async () => {
		const result = await run('fake-ok.cjs', { body: '\uFEFF\r\n  ISO-10303-21; delay=0' });
		await result.cleanup();
	});

	test('kills a child that runs past the timeout', async () => {
		const started = Date.now();
		await rejectsWith(run('fake-hang.cjs', { limits: { ...limits, timeoutMs: 500 } }), 'timeout');
		assert.ok(Date.now() - started < 3_000);
		assert.deepEqual(await tmpEntries(), []);
	});

	test('kills a child that passes the memory cap', { skip: process.platform !== 'linux' }, async () => {
		await rejectsWith(run('fake-hog.cjs', { limits: { ...limits, maxMemoryMb: 256 } }), 'memory');
		assert.deepEqual(await tmpEntries(), []);
	});

	test('reports a crashed child with its stderr', async () => {
		await assert.rejects(run('fake-crash.cjs'), (error) => {
			assert.equal(error.code, 'crashed');
			assert.match(error.message, /exited with code 3/);
			assert.match(error.detail, /boom/);
			return true;
		});
	});

	test('reports a conversion error from the child', async () => {
		await assert.rejects(run('fake-error.cjs'), (error) => {
			assert.equal(error.code, 'failed');
			assert.match(error.message, /not an IFC/);
			return true;
		});
	});

	test('reports a missing converter', async () => {
		await rejectsWith(run('does-not-exist.cjs'), 'crashed');
	});

	test('runs conversions one at a time, in order', async () => {
		const results = await Promise.all(
			[0, 1, 2].map(() => run('fake-ok.cjs', { body: 'ISO-10303-21; delay=250' })),
		);
		const spans = [];
		for (const result of results) {
			spans.push(JSON.parse(await fs.readFile(result.fragPath, 'utf8')));
			await result.cleanup();
		}
		for (let i = 1; i < spans.length; i++) {
			assert.ok(spans[i].started >= spans[i - 1].ended, `conversion ${i} overlapped ${i - 1}`);
		}
		assert.ok(results[2].queuedMs >= 400, `third waited ${results[2].queuedMs} ms`);
	});

	test('a failure releases the queue for the next conversion', async () => {
		const failing = run('fake-crash.cjs');
		const next = run('fake-ok.cjs');
		await rejectsWith(failing, 'crashed');
		const result = await next;
		await result.cleanup();
	});

	test('cancels a running conversion', async () => {
		const controller = new AbortController();
		const pending = run('fake-hang.cjs', { signal: controller.signal });
		setTimeout(() => controller.abort(), 200);
		await rejectsWith(pending, 'cancelled');
		assert.deepEqual(await tmpEntries(), []);
	});

	test('cancels a queued conversion without letting it jump the queue', async () => {
		const controller = new AbortController();
		const first = run('fake-ok.cjs', { body: 'ISO-10303-21; delay=400' });
		const queued = run('fake-ok.cjs', { signal: controller.signal });
		const third = run('fake-ok.cjs');
		setTimeout(() => controller.abort(), 100);
		await rejectsWith(queued, 'cancelled');
		const [a, c] = await Promise.all([first, third]);
		const spanA = JSON.parse(await fs.readFile(a.fragPath, 'utf8'));
		const spanC = JSON.parse(await fs.readFile(c.fragPath, 'utf8'));
		await a.cleanup();
		await c.cleanup();
		assert.ok(spanC.started >= spanA.ended, 'third started before the first finished');
	});

	test('an already-aborted signal never starts', async () => {
		const controller = new AbortController();
		controller.abort();
		await rejectsWith(run('fake-ok.cjs', { signal: controller.signal }), 'cancelled');
	});
});
