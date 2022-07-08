import {
  HoloHashMap,
  CellMap,
  SimulatedDna,
  getEntryTypeString,
  HashType,
  hash,
} from '@holochain-playground/simulator';
import {
  HoloHash,
  DhtOp,
  Action,
  ActionHash,
  EntryHash,
  DhtOpType,
  NewEntryAction,
  getDhtOpType,
  getDhtOpAction,
  getDhtOpEntry,
  CreateLink,
  DeleteLink,
  Delete,
  Update,
  Entry,
  AppEntryType,
} from '@holochain/client';

function appendToArray<T>(map: HoloHashMap<T[]>, key: HoloHash, value: T) {
  if (!map.has(key)) map.put(key, []);

  const previous_value = map.get(key);
  map.put(key, [...previous_value, value]);
}

export interface DhtSummary {
  actions: HoloHashMap<Action>;
  // Updated action -> action that updates
  actionUpdates: HoloHashMap<ActionHash[]>;
  // Deleted action -> action that deletes
  actionDeletes: HoloHashMap<ActionHash[]>;
  entries: HoloHashMap<any>;
  // Entry hash -> action that created that entry
  actionsByEntry: HoloHashMap<ActionHash[]>;
  entryLinks: HoloHashMap<
    Array<{
      target_address: EntryHash;
      tag: any;
      add_link_hash: ActionHash;
    }>
  >;
  // Deleted add link -> action that deletes that
  deletedAddLinks: HoloHashMap<ActionHash[]>;
  entryTypes: HoloHashMap<string>;
}

export function summarizeDht(
  dhtShards: CellMap<DhtOp[]>,
  simulatedDna?: SimulatedDna
): DhtSummary {
  // For every action hash, the types of Op that have been visited already
  const visited = new HoloHashMap<string[]>();

  const actions = new HoloHashMap<Action>();
  // Updated action -> action that updates
  const actionUpdates = new HoloHashMap<ActionHash[]>();
  // Deleted action -> action that deletes
  const actionDeletes = new HoloHashMap<ActionHash[]>();
  const entries = new HoloHashMap<any>();
  // Entry hash -> action that created that entry
  const actionsByEntry = new HoloHashMap<ActionHash[]>();
  const entryLinks = new HoloHashMap<
    Array<{
      target_address: EntryHash;
      tag: any;
      add_link_hash: ActionHash;
    }>
  >();
  // Deleted add link -> action that deletes that
  const deletedAddLinks = new HoloHashMap<ActionHash[]>();

  const entryTypes = new HoloHashMap<string>();
  for (const shard of dhtShards.values()) {
    for (const dhtOp of shard) {
      const dhtOpType = getDhtOpType(dhtOp);

      const action = getDhtOpAction(dhtOp);

      const actionHash = hash(action, HashType.HEADER);

      if (!visited.has(actionHash)) {
        visited.put(actionHash, []);
      }
      if (!visited.get(actionHash).includes(dhtOpType)) {
        visited.put(actionHash, [...visited.get(actionHash), dhtOpType]);

        actions.put(actionHash, action);

        if (dhtOpType === DhtOpType.StoreEntry) {
          const entry_hash = (action as NewEntryAction).entry_hash;
          const entry = getDhtOpEntry(dhtOp);
          entries.put(entry_hash, entry);
          appendToArray(actionsByEntry, entry_hash, actionHash);

          const entryType = simulatedDna
            ? getEntryTypeString(
                simulatedDna,
                (action as NewEntryAction).entry_type
              )
            : getConnectedEntryType(action as NewEntryAction, entry);
          entryTypes.put(entry_hash, entryType);
        } else if (dhtOpType === DhtOpType.RegisterAddLink) {
          const base_address = (action as CreateLink).base_address;
          const target_address = (action as CreateLink).target_address;
          const tag = (action as CreateLink).tag;
          appendToArray(entryLinks, base_address, {
            tag,
            target_address,
            add_link_hash: actionHash,
          });
        } else if (dhtOpType === DhtOpType.RegisterRemoveLink) {
          const add_link_hash = (action as DeleteLink).link_add_address;
          appendToArray(deletedAddLinks, add_link_hash, actionHash);
        } else if (
          dhtOpType === DhtOpType.RegisterDeletedBy ||
          dhtOpType === DhtOpType.RegisterDeletedEntryAction
        ) {
          const deletedAction = (action as Delete).deletes_address;
          appendToArray(actionDeletes, deletedAction, actionHash);
        } else if (
          dhtOpType === DhtOpType.RegisterUpdatedContent ||
          dhtOpType === DhtOpType.RegisterUpdatedRecord
        ) {
          const updatedAction = (action as Update).original_action_address;
          appendToArray(actionUpdates, updatedAction, actionHash);
        }
      }
    }
  }

  return {
    actions,
    actionUpdates,
    actionDeletes,
    entries,
    actionsByEntry,
    entryLinks,
    deletedAddLinks,
    entryTypes,
  };
}

export function isEntryDeleted(
  summary: DhtSummary,
  entryHash: EntryHash
): boolean {
  const actions = summary.actionsByEntry.get(entryHash);
  const aliveActions = actions.filter((h) => !summary.actionDeletes.has(h));

  return aliveActions.length === 0;
}

function getConnectedEntryType(action: NewEntryAction, entry: Entry): string {
  if (
    entry.entry_type !== 'App' &&
    (entry.entry_type as any) !== 'CounterSign'
  ) {
    return entry.entry_type;
  }
  const appEntryType = (
    action.entry_type as {
      App: AppEntryType;
    }
  ).App;

  return `Zome:${appEntryType.zome_id},EntryId:${appEntryType.id}`;
}
