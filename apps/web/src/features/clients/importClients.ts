/**
 * Turning a spreadsheet of clients into clients and properties: the shared rules in
 * packages/core/src/clientImport.ts, which the AI assistants' import uses too. Built for Jobber's
 * exports (the Clients export and the Properties export) and most other tools' too: rows with the
 * same client ID, email or name are one client, and a client already here gets the properties
 * instead of a duplicate.
 */
export {
  IMPORT_TARGETS as TARGETS,
  guessMapping,
  sameStreet,
  toClients,
  type ImportAddress as Address,
  type ImportClient,
  type ImportMapping as Mapping,
  type ImportTargetKey as TargetKey,
} from "@crewtavo/core/clientImport";
