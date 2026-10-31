import type { AttributeLiteral, Expression } from '../luau/vendor/types.js';

/** Attribute arguments use native AST literal rules, rather than constant folding. */
export function attributeLiteral(node: Expression, depth = 0): AttributeLiteral {
	if (depth > 128 || node.parenthesized) throw new Error('Not an attribute literal');
	switch (node.type) {
		case 'Nil': return null;
		case 'Number': case 'Boolean': case 'String': return node.value;
		case 'Table': return { fields: node.fields.map((field) => {
			if (field.computed || field.key && field.key.type !== 'Identifier') throw new Error('Computed attribute key');
			return { ...(field.key?.type === 'Identifier' ? { key: field.key.name } : {}), value: attributeLiteral(field.value, depth + 1) };
		}) };
		default: throw new Error('Not an attribute literal');
	}
}

export function validDeprecatedArguments(args: AttributeLiteral[]): boolean {
	if (!args.length) return true;
	const record = args[0];
	return args.length === 1 && typeof record === 'object' && record !== null &&
		record.fields.every((field) => (field.key === 'use' || field.key === 'reason') && typeof field.value === 'string');
}
