// Runs one IFC → .frag conversion in a child process, one at a time per n8n
// process.
//
// Why a child process and not a worker thread: web-ifc's WASM memory lives
// outside the V8 heap, so neither `--max-old-space-size` nor worker
// `resourceLimits` cap it. A separate process can be measured (RSS) and
// killed without taking n8n down with it.

import { fork, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ChildMessage, ConvertJob } from './protocol';

export type ConversionErrorCode =
	| 'empty'
	| 'not_ifc'
	| 'too_large'
	| 'timeout'
	| 'memory'
	| 'cancelled'
	| 'crashed'
	| 'failed';

export class ConversionError extends Error {
	constructor(
		readonly code: ConversionErrorCode,
		message: string,
		/** Child stderr/stdout tail, when there is one. */
		readonly detail?: string,
	) {
		super(message);
		this.name = 'ConversionError';
	}
}

export interface ConvertLimits {
	timeoutMs: number;
	maxIfcBytes: number;
	/** RSS cap for the child (Linux), and its V8 heap cap everywhere. */
	maxMemoryMb: number;
}

export interface ConvertRequest {
	source: Readable;
	modelId?: string;
	distanceThreshold: number | null;
	limits: ConvertLimits;
	signal?: AbortSignal;
	/** Path of the bundled converter. Tests point this at fake children. */
	childPath: string;
	tmpRoot?: string;
}

export interface ConvertResult {
	fragPath: string;
	ifcBytes: number;
	fragBytes: number;
	/** IfcImporter.process() alone, measured in the child. */
	convertMs: number;
	/** Spool + child start + conversion + exit, excluding the queue wait. */
	totalMs: number;
	queuedMs: number;
	/** Highest sampled child RSS. Null where /proc is unavailable. */
	peakRssMb: number | null;
	/** Removes the temp dir. Call once the .frag has been read. */
	cleanup(): Promise<void>;
}

const RSS_POLL_MS = 100;
const EXIT_GRACE_MS = 5_000;
const TAIL_BYTES = 4_096;
const HEAD_BYTES = 64;

// ---------------------------------------------------------------------------
// One conversion at a time, per process. Kept on globalThis so two loaded
// copies of this package (custom dir + community install) still share it.
// ---------------------------------------------------------------------------

interface Queue {
	tail: Promise<void>;
}

const QUEUE_KEY = Symbol.for('n8n-nodes-fragments.queue');

function queue(): Queue {
	const g = globalThis as unknown as Record<symbol, Queue | undefined>;
	return (g[QUEUE_KEY] ??= { tail: Promise.resolve() });
}

async function acquire(signal?: AbortSignal): Promise<() => void> {
	const q = queue();
	let release!: () => void;
	const mine = new Promise<void>((resolve) => (release = resolve));
	const previous = q.tail;
	// Waiters behind us wait for `previous` AND `mine`, so releasing early on
	// abort cannot let anyone overtake the conversion that is still running.
	q.tail = previous.then(() => mine);
	let acquired = false;
	try {
		await untilAborted(previous, signal);
		acquired = true;
	} finally {
		if (!acquired) release();
	}
	return release;
}

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(cancelled());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(cancelled());
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

function cancelled() {
	return new ConversionError('cancelled', 'Conversion cancelled because the execution was stopped');
}

// ---------------------------------------------------------------------------

export async function convertIfc(req: ConvertRequest): Promise<ConvertResult> {
	const queuedAt = Date.now();
	const release = await acquire(req.signal);
	const startedAt = Date.now();
	let workDir: string | undefined;
	try {
		workDir = await fs.mkdtemp(join(req.tmpRoot ?? tmpdir(), 'n8n-frag-'));
		const inputPath = join(workDir, 'input.ifc');
		const outputPath = join(workDir, 'output.frag');

		const { bytes: ifcBytes, head } = await spool(req.source, inputPath, req.limits.maxIfcBytes);
		if (ifcBytes === 0) throw new ConversionError('empty', 'The input binary is empty');
		assertStepFile(head);

		const job: ConvertJob = {
			type: 'convert',
			inputPath,
			outputPath,
			modelId: req.modelId,
			distanceThreshold: req.distanceThreshold,
		};
		const { done, peakRssMb } = await runChild(req, job);

		const dir = workDir;
		workDir = undefined; // ownership moves to the caller's cleanup()
		return {
			fragPath: outputPath,
			ifcBytes,
			fragBytes: done.fragBytes,
			convertMs: done.convertMs,
			totalMs: Date.now() - startedAt,
			queuedMs: startedAt - queuedAt,
			peakRssMb,
			cleanup: () => fs.rm(dir, { recursive: true, force: true }),
		};
	} finally {
		if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
		release();
	}
}

/**
 * Streams the IFC to disk, refusing it as soon as it passes `maxBytes`, and
 * keeps the first bytes for the format check.
 */
async function spool(
	source: Readable,
	path: string,
	maxBytes: number,
): Promise<{ bytes: number; head: Buffer }> {
	let bytes = 0;
	let head = Buffer.alloc(0);
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES)]);
			if (bytes > maxBytes) {
				callback(
					new ConversionError(
						'too_large',
						`The IFC is larger than the ${formatMb(maxBytes)} limit (Max IFC Size)`,
					),
				);
				return;
			}
			callback(null, chunk);
		},
	});
	await pipeline(source, counter, createWriteStream(path));
	return { bytes, head };
}

/** web-ifc reads IFC-SPF (STEP) only; anything else fails deep inside it with a useless message. */
function assertStepFile(head: Buffer) {
	if (head.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'latin1'))) {
		throw new ConversionError('not_ifc', 'The input is a ZIP (ifcZIP?). Unzip it to the .ifc first.');
	}
	const text = head.toString('latin1').replace(/^\xEF\xBB\xBF/, '').trimStart();
	if (!text.startsWith('ISO-10303-21')) {
		throw new ConversionError(
			'not_ifc',
			'The input is not an IFC STEP file (it does not start with ISO-10303-21). ifcXML and ifcZIP are not supported.',
		);
	}
}

function runChild(
	req: ConvertRequest,
	job: ConvertJob,
): Promise<{ done: Extract<ChildMessage, { type: 'done' }>; peakRssMb: number | null }> {
	const { timeoutMs, maxMemoryMb } = req.limits;

	return new Promise((resolve, reject) => {
		const child = fork(req.childPath, [], {
			execArgv: [`--max-old-space-size=${Math.max(64, Math.floor(maxMemoryMb))}`],
			env: {},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			serialization: 'json',
		});

		const stderr = tail(child.stderr);
		const stdout = tail(child.stdout);
		let peakRss: number | null = null;
		const outcome: { done?: Extract<ChildMessage, { type: 'done' }>; error?: ConversionError } = {};
		let settled = false;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(poller);
			req.signal?.removeEventListener('abort', onAbort);
			const peakRssMb = peakRss === null ? null : Math.round(peakRss / 1024 / 1024);
			if (outcome.done && !outcome.error) resolve({ done: outcome.done, peakRssMb });
			else reject(outcome.error ?? crashedError(child, stderr(), stdout()));
		};

		// First failure wins; the child is killed and we settle on 'exit'. Once
		// the child has reported success, a late limit hit only hurries it out.
		const fail = (error: ConversionError) => {
			if (!outcome.done) outcome.error ??= error;
			kill(child);
		};

		const timer = setTimeout(
			() =>
				fail(
					new ConversionError(
						'timeout',
						`The conversion took longer than ${Math.round(timeoutMs / 1000)} s (Timeout) and was stopped`,
					),
				),
			timeoutMs,
		);

		const poller = setInterval(() => {
			const rss = readRss(child.pid);
			if (rss === null) return;
			peakRss = Math.max(peakRss ?? 0, rss);
			if (rss > maxMemoryMb * 1024 * 1024) {
				fail(
					new ConversionError(
						'memory',
						`The converter used more than ${maxMemoryMb} MB (Max Memory) and was stopped`,
					),
				);
			}
		}, RSS_POLL_MS);

		const onAbort = () => fail(cancelled());
		if (req.signal?.aborted) onAbort();
		else req.signal?.addEventListener('abort', onAbort, { once: true });

		child.on('message', (message: ChildMessage) => {
			if (message.type === 'done') {
				outcome.done = message;
				// The child exits on its own; don't wait forever if it hangs.
				setTimeout(() => kill(child), EXIT_GRACE_MS).unref();
			} else if (message.type === 'error') {
				outcome.error ??= new ConversionError(
					'failed',
					`The IFC could not be converted: ${message.message}`,
					stderr() || undefined,
				);
			}
		});
		child.on('error', (error) => {
			outcome.error ??= new ConversionError(
				'crashed',
				`The converter process could not run: ${error.message}`,
			);
			finish();
		});
		child.on('exit', finish);

		child.send(job);
	});
}

function kill(child: ChildProcess) {
	if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function crashedError(child: ChildProcess, stderr: string, stdout: string) {
	const how =
		child.signalCode !== null ? `was killed (${child.signalCode})` : `exited with code ${child.exitCode}`;
	const oom = /heap out of memory|Cannot enlarge memory|out of memory/i.test(stderr)
		? ' It ran out of memory: raise Max Memory or convert a smaller model.'
		: '';
	return new ConversionError(
		'crashed',
		`The converter process ${how} before finishing.${oom}`,
		[stderr, stdout].filter(Boolean).join('\n') || undefined,
	);
}

/** Keeps the last few KB of a child stream for error messages. */
function tail(stream: Readable | null): () => string {
	let buffer = '';
	stream?.setEncoding('utf8');
	stream?.on('data', (chunk: string) => {
		buffer = (buffer + chunk).slice(-TAIL_BYTES);
	});
	return () => buffer.trim();
}

/** Resident set size of `pid` in bytes, from /proc (Linux). */
function readRss(pid: number | undefined): number | null {
	if (!pid || process.platform !== 'linux') return null;
	try {
		// Synchronous on purpose: /proc reads don't touch disk, and a 100 ms
		// cadence keeps a fast-growing child from overshooting by much.
		const status = readFileSync(`/proc/${pid}/status`, 'utf8');
		const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
		return match ? Number(match[1]) * 1024 : null;
	} catch {
		return null; // the child has already exited
	}
}

function formatMb(bytes: number) {
	return `${Math.round(bytes / 1024 / 1024)} MB`;
}
