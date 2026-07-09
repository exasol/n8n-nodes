import type { INodeProperties } from 'n8n-workflow';

import { schemaAndTableFields } from '../shared/schemaTableFields';
import { whereFields } from '../shared/whereFields';

// Shared by every property below — visible only when the Operation dropdown is "Delete".
const displayOptions = {
	show: {
		operation: ['delete'],
	},
};

/**
 * INodeProperties entries rendered when operation === 'delete'.
 *
 * Delete issues one DELETE statement per n8n input item — like Update, and unlike Insert, which
 * batches every item into a single multi-row statement. There is no column mapping here (DELETE
 * has no SET clause), so this is just the schema/table pickers plus the shared WHERE builder.
 * WHERE reuses the same fixed-collection shape as Select Rows and Update; it is required here —
 * an empty Where would otherwise delete every row in the table, which execute.ts guards against
 * at runtime.
 */
export const description: INodeProperties[] = [
	...schemaAndTableFields(displayOptions, 'delete from', 'delete rows from'),
	// Unlike Select Rows, an empty Where is rejected at runtime (see execute.ts): Delete has no
	// "delete all rows" mode.
	...whereFields(
		displayOptions,
		'deleted',
		'Conditions a row must match to be deleted. At least one condition is required, to guard against unintentionally deleting every row in the table.',
	),
];
