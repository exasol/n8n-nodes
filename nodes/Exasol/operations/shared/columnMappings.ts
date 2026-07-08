import type { IExecuteFunctions } from 'n8n-workflow';

/**
 * Reads the "Columns" fixedCollection for one input item. A fixedCollection with
 * multipleValues returns { mappings: [...] }, or {} when no rows have been added.
 *
 * Shared by every operation that lets the user map columns explicitly via a "Columns" collection
 * (Insert, Update, and — in later PRs — Upsert).
 *
 * @param context - execute context, used to read the node parameter for this item
 * @param itemIndex - index of the input item being processed
 * @returns the configured column/value mappings, or an empty array if none were added
 */
export function readColumnMappings(
	context: IExecuteFunctions,
	itemIndex: number,
): Array<{ column: string; value?: unknown }> {
	const collection = context.getNodeParameter('columns', itemIndex, {}) as {
		mappings?: Array<{ column: string; value?: unknown }>;
	};
	return collection.mappings ?? [];
}
