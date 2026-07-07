import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * Validates that a required string parameter (e.g. Schema, Table) is non-empty once whitespace
 * is trimmed, and returns the trimmed value.
 *
 * Fields like Schema and Table are marked `required` in each operation's description.ts, but
 * that only stops the UI from saving an empty default — an n8n expression can still resolve the
 * field to '' (or whitespace), or even a non-string value such as a number, at runtime, so it
 * must be validated again here. `value` is therefore typed `unknown` rather than trusted via a
 * `getNodeParameter(...) as string` cast at the call site — a non-string is treated the same as
 * an empty value rather than throwing a raw TypeError out of `.trim()`. The trimmed value is what
 * gets returned, since the untrimmed original would otherwise be quoted verbatim as a SQL
 * identifier further down and silently fail to match the real schema/table name.
 *
 * Shared by every operation that reads a Schema/Table pair (Select Rows, Insert, and — in later
 * PRs — Update, Delete, Upsert).
 *
 * @throws NodeOperationError (with itemIndex) when `value` is empty, whitespace-only, or not a
 *   string
 */
export function requireNonEmpty(
	context: IExecuteFunctions,
	value: unknown,
	fieldLabel: string,
	itemIndex: number,
): string {
	const trimmed = typeof value === 'string' ? value.trim() : '';
	if (!trimmed) {
		throw new NodeOperationError(context.getNode(), `${fieldLabel} must not be empty`, {
			itemIndex,
		});
	}
	return trimmed;
}
