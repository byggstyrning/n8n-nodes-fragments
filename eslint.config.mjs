// The same rules n8n's community-package scan (`@n8n/scan-community-package`)
// applies to node sources, minus the three this node breaks on purpose:
// it needs node built-ins (fs, path, stream, os), process/timer globals, and
// child_process.fork to run the converter in an isolated process. That makes
// it a self-hosted-only community node; it cannot be n8n-verified.
import { defineConfig } from 'eslint/config';
import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import tsParser from '@typescript-eslint/parser';

export default defineConfig(
	n8nCommunityNodesPlugin.configs.recommended,
	{ rules: { 'no-console': 'error' } },
	{ plugins: { 'n8n-nodes-base': n8nNodesBase } },
	{ files: ['package.json'], rules: { ...n8nNodesBase.configs.community.rules } },
	{
		files: ['**/nodes/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.nodes.rules,
			'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
			'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
			'n8n-nodes-base/node-param-type-options-max-value-present': 'off',
		},
	},
	{
		files: ['nodes/**/*.ts'],
		rules: {
			'@n8n/community-nodes/no-restricted-imports': 'off',
			'@n8n/community-nodes/no-restricted-globals': 'off',
			'@n8n/community-nodes/no-dangerous-functions': 'off',
		},
	},
	{ files: ['**/*.json', '**/*.ts'], languageOptions: { parser: tsParser } },
);
