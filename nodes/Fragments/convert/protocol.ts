// Messages between the n8n process (runner.ts) and the converter child
// (child.ts). JSON over the fork IPC channel; the IFC and the .frag travel
// as files in a private temp dir, never through IPC.

export interface ConvertJob {
	type: 'convert';
	inputPath: string;
	outputPath: string;
	/** Embedded model GUID. Undefined → IfcImporter picks a random UUID. */
	modelId?: string;
	/** Drop items further than this from the origin. Null keeps everything. */
	distanceThreshold: number | null;
}

export type ChildMessage =
	| { type: 'done'; ifcBytes: number; fragBytes: number; convertMs: number }
	| { type: 'error'; message: string };
