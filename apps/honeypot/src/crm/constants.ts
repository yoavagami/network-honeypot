/** Shared between the query implementations (the actual cap) and the detection logic in
 * routes/crm.ts (which uses it as the anomaly threshold — a legitimate query can never return
 * more than this many rows, so seeing more is proof the cap got bypassed). */
export const CRM_SEARCH_RESULT_LIMIT = 50;
