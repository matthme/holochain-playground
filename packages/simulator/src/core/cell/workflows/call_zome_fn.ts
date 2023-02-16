import {
  AgentPubKey,
  ActionType,
  NewEntryAction,
  SignedActionHashed,
  Record,
  encodeHashToBase64,
} from '@holochain/client';
import { cloneDeep } from 'lodash-es';

import { SimulatedZome } from '../../../dnas/simulated-dna';
import { areEqual } from '../../../processors/hash';
import { GetStrategy } from '../../../types';
import { BadAgentConfig } from '../../bad-agent';
import { buildZomeFunctionContext } from '../../hdk/context';
import { HostFnWorkspace } from '../../hdk/host-fn';
import { Cascade } from '../cascade/cascade';
import { getTipOfChain, valid_cap_grant } from '../source-chain/utils';
import { CellState } from '../state';
import { ValidationOutcome } from '../sys_validate/types';
import {
  run_create_link_validation_callback,
  run_delete_link_validation_callback,
  run_validation_callback_direct,
} from './app_validation';
import { produce_dht_ops_task } from './produce_dht_ops';
import { sys_validate_record } from './sys_validation';
import { Workflow, WorkflowType, Workspace } from './workflows';

/**
 * Calls the zome function of the cell DNA
 * This can only be called in the simulated mode: we can assume that cell.simulatedDna exists
 */
export const callZomeFn =
  (
    zomeName: string,
    fnName: string,
    payload: any,
    provenance: AgentPubKey,
    cap: Uint8Array
  ) =>
  async (
    workspace: Workspace
  ): Promise<{ result: any; triggers: Array<Workflow<any, any>> }> => {
    if (!valid_cap_grant(workspace.state, zomeName, fnName, provenance, cap))
      throw new Error('Unauthorized Zome Call');

    const currentAction = getTipOfChain(workspace.state);
    const chain_head_start_len = workspace.state.sourceChain.length;

    const zomeIndex = workspace.dna.zomes.findIndex(
      (zome) => zome.name === zomeName
    );
    if (zomeIndex < 0)
      throw new Error(`There is no zome with the name ${zomeName} in this DNA`);

    const zome = workspace.dna.zomes[zomeIndex];
    if (!zome.zome_functions[fnName])
      throw new Error(
        `There isn't a function with the name ${fnName} in this zome with the name ${zomeName}`
      );

    const contextState = cloneDeep(workspace.state);

    const hostFnWorkspace: HostFnWorkspace = {
      cascade: new Cascade(workspace.state, workspace.p2p),
      state: contextState,
      dna: workspace.dna,
      p2p: workspace.p2p,
    };
    const zomeFnContext = buildZomeFunctionContext(hostFnWorkspace, zomeIndex);

    const result = await zome.zome_functions[fnName].call(zomeFnContext)(
      payload
    );

    let triggers: Array<Workflow<any, any>> = [];
    if (!areEqual(getTipOfChain(contextState), currentAction)) {
      // Do validation
      let i = chain_head_start_len;

      const recordsToAppValidate = [];

      while (i < contextState.sourceChain.length) {
        const actionHash = contextState.sourceChain[i];
        const signed_action: SignedActionHashed =
          contextState.CAS.get(actionHash);
        const entry_hash = (signed_action.hashed.content as NewEntryAction)
          .entry_hash;

        const record: Record = {
          entry: entry_hash
            ? { Present: contextState.CAS.get(entry_hash) }
            : { NotApplicable: null },
          signed_action,
        };

        const depsMissing = await sys_validate_record(
          record,
          { ...workspace, state: contextState },
          workspace.p2p
        );
        if (depsMissing)
          throw new Error(
            `Could not validate a new record due to missing dependencies`
          );

        recordsToAppValidate.push(record);
        i++;
      }

      if (shouldValidateBeforePublishing(workspace.badAgentConfig)) {
        for (const record of recordsToAppValidate) {
          const outcome = await run_app_validation(
            zome,
            record,
            contextState,
            workspace
          );
          if (!outcome.resolved)
            throw new Error(
              'Error creating a new record: missing dependencies'
            );
          if (!outcome.valid)
            throw new Error('Error creating a new record: invalid');
        }
      }

      triggers.push(produce_dht_ops_task());
    }

    workspace.state.CAS = contextState.CAS;
    workspace.state.sourceChain = contextState.sourceChain;

    return {
      result: cloneDeep(result),
      triggers,
    };
  };

export type CallZomeFnWorkflow = Workflow<
  { zome: string; fnName: string; payload: any },
  any
>;

export function call_zome_fn_workflow(
  zome: string,
  fnName: string,
  payload: any,
  provenance: AgentPubKey
): CallZomeFnWorkflow {
  return {
    type: WorkflowType.CALL_ZOME,
    details: {
      fnName,
      payload,
      zome,
    },
    task: (worskpace) =>
      callZomeFn(
        zome,
        fnName,
        payload,
        provenance,
        new Uint8Array()
      )(worskpace),
  };
}

function shouldValidateBeforePublishing(
  badAgentConfig?: BadAgentConfig
): boolean {
  if (!badAgentConfig) return true;
  return !badAgentConfig.disable_validation_before_publish;
}

async function run_app_validation(
  zome: SimulatedZome,
  record: Record,
  contextState: CellState,
  workspace: Workspace
): Promise<ValidationOutcome> {
  const action = record.signed_action.hashed.content;
  if (action.type === ActionType.CreateLink) {
    const cascade = new Cascade(contextState, workspace.p2p);
    const baseEntry = await cascade.retrieve_entry(action.base_address, {
      strategy: GetStrategy.Contents,
    });
    if (!baseEntry) {
      return {
        resolved: false,
        depsHashes: [action.base_address],
      };
    }
    const targetEntry = await cascade.retrieve_entry(action.target_address, {
      strategy: GetStrategy.Contents,
    });
    if (!targetEntry) {
      return {
        resolved: false,
        depsHashes: [action.target_address],
      };
    }
    return run_create_link_validation_callback(
      zome,
      action,
      baseEntry,
      targetEntry,
      workspace
    );
  } else if (action.type === ActionType.DeleteLink) {
    return run_delete_link_validation_callback(zome, action, workspace);
  } else if (
    action.type === ActionType.Create ||
    action.type === ActionType.Update ||
    action.type === ActionType.Delete
  ) {
    return run_validation_callback_direct(
      zome,
      workspace.dna,
      record,
      workspace
    );
  }
  return {
    valid: true,
    resolved: true,
  };
}
