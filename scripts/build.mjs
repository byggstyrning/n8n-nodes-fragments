// Builds dist/ with esbuild. Two bundles, no runtime dependencies:
//   dist/nodes/Fragments/Fragments.node.js  the n8n node (only n8n-workflow external)
//   dist/nodes/Fragments/converter.js       the child: fragments + three + web-ifc inlined
// plus the web-ifc WASM, the icon, and THIRD_PARTY_NOTICES.md.
// Also emits .test-build/runner.cjs so the tests can drive the runner directly.

import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/nodes/Fragments');
const pkgJson = async (dir) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
const moduleDir = (name) => join(root, 'node_modules', name);

const define = {
	__FRAGMENTS_VERSION__: JSON.stringify((await pkgJson(moduleDir('@thatopen/fragments'))).version),
	__WEB_IFC_VERSION__: JSON.stringify((await pkgJson(moduleDir('web-ifc'))).version),
};

const common = {
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	define,
	metafile: true,
	logLevel: 'warning',
};

await rm(join(root, 'dist'), { recursive: true, force: true });
await rm(join(root, '.test-build'), { recursive: true, force: true });

const node = await build({
	...common,
	entryPoints: { 'Fragments.node': join(root, 'nodes/Fragments/Fragments.node.ts') },
	outdir: out,
	external: ['n8n-workflow'],
});
const converter = await build({
	...common,
	entryPoints: { converter: join(root, 'nodes/Fragments/convert/child.ts') },
	outdir: out,
	legalComments: 'none', // licences go to THIRD_PARTY_NOTICES.md instead
});
await build({
	...common,
	entryPoints: { runner: join(root, 'nodes/Fragments/convert/runner.ts') },
	outdir: join(root, '.test-build'),
	outExtension: { '.js': '.cjs' },
});

// The whole point of bundling: nothing may be required at runtime except
// node built-ins (and n8n-workflow, which n8n provides, for the node file).
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
assertExternals(node, new Set([...builtins, 'n8n-workflow']));
assertExternals(converter, builtins);

await mkdir(join(out, 'wasm'), { recursive: true });
await cp(join(moduleDir('web-ifc'), 'web-ifc-node.wasm'), join(out, 'wasm/web-ifc-node.wasm'));
for (const file of ['fragments.svg', 'fragments.dark.svg', 'Fragments.node.json']) {
	await cp(join(root, 'nodes/Fragments', file), join(out, file));
}
await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), await notices(converter));
await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(root, 'dist/THIRD_PARTY_NOTICES.md'));

for (const [file, info] of Object.entries({ ...node.metafile.outputs, ...converter.metafile.outputs })) {
	console.log(`${file.replace(root + '/', '')}  ${(info.bytes / 1024).toFixed(0)} KB`);
}

function assertExternals(result, allowed) {
	for (const [file, info] of Object.entries(result.metafile.outputs)) {
		const bad = info.imports.filter((i) => i.external && !allowed.has(i.path)).map((i) => i.path);
		if (bad.length) throw new Error(`${file} requires non-bundled modules at runtime: ${bad.join(', ')}`);
	}
}

/** Licence texts for every package inlined into the converter, plus the WASM. */
async function notices(result) {
	const packages = new Map();
	for (const input of Object.keys(result.metafile.inputs)) {
		const match = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(input);
		if (match) packages.set(match[1], moduleDirOf(input, match[1]));
	}
	packages.set('web-ifc', moduleDir('web-ifc')); // the WASM is copied, not bundled
	// @thatopen/fragments' own dist inlines its dependencies; list them too.
	const fragmentsDeps = join(await realpath(moduleDir('@thatopen/fragments')), '../..');
	for (const dep of Object.keys((await pkgJson(moduleDir('@thatopen/fragments'))).dependencies ?? {})) {
		packages.set(dep, join(fragmentsDeps, dep));
	}

	let text =
		'# Third-party notices\n\n' +
		'`dist/nodes/Fragments/converter.js` bundles the packages below, unmodified (earcut,\n' +
		'flatbuffers, lru-cache and pako arrive already inlined in @thatopen/fragments), and\n' +
		'`dist/nodes/Fragments/wasm/web-ifc-node.wasm` is copied from web-ifc unmodified.\n' +
		'web-ifc is MPL-2.0; its source is at https://github.com/ThatOpen/engine_web-ifc.\n';
	for (const name of [...packages.keys()].sort()) {
		const dir = packages.get(name);
		const pkg = await pkgJson(dir);
		const licenseFile = (await readdir(dir)).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
		const vendored = join(root, 'licenses', `${name.replace(/^@|\//g, (c) => (c === '/' ? '-' : ''))}.LICENSE.md`);
		const body = licenseFile
			? await readFile(join(dir, licenseFile), 'utf8')
			: await readFile(vendored, 'utf8').catch(() => '(no licence file shipped)');
		text += `\n## ${name} ${pkg.version} (${pkg.license ?? 'unknown'})\n\n\`\`\`\n${body.trim()}\n\`\`\`\n`;
	}
	return text;
}

function moduleDirOf(input, name) {
	const idx = input.lastIndexOf(`node_modules/${name}/`);
	return join(root, input.slice(0, idx + `node_modules/${name}`.length));
}
