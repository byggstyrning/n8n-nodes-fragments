import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type {
	IBinaryData,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { ConversionError, convertIfc } from './convert/runner';

declare const __FRAGMENTS_VERSION__: string;
declare const __WEB_IFC_VERSION__: string;

interface Options {
	fileName?: string;
	modelId?: string;
	timeout?: number;
	maxIfcSizeMb?: number;
	maxMemoryMb?: number;
	distanceThreshold?: number;
	keepInputBinary?: boolean;
}

const CHILD_PATH = join(__dirname, 'converter.js');

export class Fragments implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'IFC to Fragments',
		name: 'fragments',
		icon: { light: 'file:fragments.svg', dark: 'file:fragments.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: 'IFC → .frag',
		description:
			'Convert an IFC file to That Open Fragments (.frag) inside this n8n instance, in an isolated child process',
		defaults: { name: 'IFC to Fragments' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// As an AI tool it converts whatever IFC binary the agent's input item carries.
		usableAsTool: true,
		properties: [
			{
				displayName:
					'Conversions run one at a time per n8n process, each in its own child process with the limits below. Others wait their turn.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				description: 'Name of the binary field that holds the IFC file',
			},
			{
				displayName: 'Output Binary Field',
				name: 'outputBinaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				description: 'Name of the binary field to write the .frag file to',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Distance Threshold',
						name: 'distanceThreshold',
						type: 'number',
						default: 100000,
						description:
							'Drop geometry further than this from the origin (model units). 0 keeps everything.',
					},
					{
						displayName: 'Keep Input Binary',
						name: 'keepInputBinary',
						type: 'boolean',
						default: false,
						description:
							'Whether to keep the IFC on the output item when the output field differs from the input field',
					},
					{
						displayName: 'Max IFC Size (MB)',
						name: 'maxIfcSizeMb',
						type: 'number',
						default: 512,
						typeOptions: { minValue: 1 },
						description: 'Larger inputs are refused before any conversion starts',
					},
					{
						displayName: 'Max Memory (MB)',
						name: 'maxMemoryMb',
						type: 'number',
						default: 3072,
						typeOptions: { minValue: 128 },
						description:
							'Memory cap for the converter process. On Linux its resident memory is watched and the process is stopped above this; elsewhere only the JavaScript heap is capped.',
					},
					{
						displayName: 'Model ID',
						name: 'modelId',
						type: 'string',
						default: '',
						description:
							'GUID embedded in the .frag. Leave empty for a random UUID. Set it (e.g. to a file version ID) to get byte-identical output for the same IFC.',
					},
					{
						displayName: 'Output File Name',
						name: 'fileName',
						type: 'string',
						default: '',
						placeholder: 'model.frag',
						description: 'Defaults to the IFC file name with a .frag extension',
					},
					{
						displayName: 'Timeout (Seconds)',
						name: 'timeout',
						type: 'number',
						default: 600,
						typeOptions: { minValue: 1 },
						description:
							'Stop the conversion after this long. Time spent waiting for another conversion does not count.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const signal = this.getExecutionCancelSignal?.();

		for (let i = 0; i < items.length; i++) {
			try {
				const inField = this.getNodeParameter('binaryPropertyName', i) as string;
				const outField = this.getNodeParameter('outputBinaryPropertyName', i) as string;
				const options = this.getNodeParameter('options', i, {}) as Options;

				const binary = this.helpers.assertBinaryData(i, inField);
				const source = binary.id
					? await this.helpers.getBinaryStream(binary.id)
					: Readable.from(Buffer.from(binary.data, 'base64'));

				const threshold = options.distanceThreshold ?? 100000;
				const modelId = options.modelId?.trim() || undefined;
				const result = await convertIfc({
					source,
					modelId,
					distanceThreshold: threshold > 0 ? threshold : null,
					limits: {
						timeoutMs: (options.timeout ?? 600) * 1000,
						maxIfcBytes: (options.maxIfcSizeMb ?? 512) * 1024 * 1024,
						maxMemoryMb: options.maxMemoryMb ?? 3072,
					},
					signal,
					childPath: CHILD_PATH,
				});

				try {
					const fileName = options.fileName?.trim() || fragFileName(binary);
					const frag = await fs.readFile(result.fragPath);
					const prepared = await this.helpers.prepareBinaryData(
						frag,
						fileName,
						'application/octet-stream',
					);
					prepared.fileExtension = 'frag';

					const outBinary = { ...items[i].binary };
					if (!options.keepInputBinary) delete outBinary[inField];
					outBinary[outField] = prepared;

					returnData.push({
						json: {
							...items[i].json,
							fragments: {
								fileName,
								modelId: modelId ?? null,
								ifcBytes: result.ifcBytes,
								fragBytes: result.fragBytes,
								convertMs: result.convertMs,
								totalMs: result.totalMs,
								queuedMs: result.queuedMs,
								peakRssMb: result.peakRssMb,
								fragmentsVersion: __FRAGMENTS_VERSION__,
								webIfcVersion: __WEB_IFC_VERSION__,
							},
						},
						binary: outBinary,
						pairedItem: { item: i },
					});
				} finally {
					await result.cleanup();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							...items[i].json,
							error: message,
							errorCode: error instanceof ConversionError ? error.code : undefined,
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error instanceof Error ? error : message, {
					itemIndex: i,
					description: error instanceof ConversionError ? error.detail : undefined,
				});
			}
		}

		return [returnData];
	}
}

function fragFileName(binary: IBinaryData): string {
	const base = (binary.fileName ?? 'model').replace(/\.ifc(zip|xml)?$/i, '');
	return `${base}.frag`;
}
