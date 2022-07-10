import { ActionHash, NewEntryAction, Record } from '@holochain/client';

import { GetStrategy } from '../../../../../types';
import {
  buildDelete,
  buildShh,
} from '../../../../cell/source-chain/builder-actions';
import { putRecord } from '../../../../cell/source-chain/put';
import { HostFnWorkspace } from '../../../host-fn';

export async function common_delete(
  worskpace: HostFnWorkspace,
  action_hash: ActionHash
): Promise<ActionHash> {
  const actionToDelete = await worskpace.cascade.retrieve_action(action_hash, {
    strategy: GetStrategy.Contents,
  });

  if (!actionToDelete) throw new Error('Could not find record to be deleted');

  const deletesEntryAddress = (actionToDelete.hashed.content as NewEntryAction)
    .entry_hash;

  if (!deletesEntryAddress)
    throw new Error(`Trying to delete an record with no entry`);

  const deleteAction = buildDelete(
    worskpace.state,
    action_hash,
    deletesEntryAddress
  );

  const record: Record = {
    signed_action: buildShh(deleteAction),
    entry: undefined,
  };
  putRecord(record)(worskpace.state);

  return record.signed_action.hashed.hash;
}
