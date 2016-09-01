import {
        ref as $ref,
            atom as $atom,
            pathValue as $value,
            pathInvalidation as $invalidate
} from 'reaxtor-falcor-json-graph';

import { Observable } from 'rxjs';
import { SET_INVESTIGATION_NAME } from 'viz-shared/actions/investigationList';

export default function investigation(action$, store) {
        return setInvestigationName(action$, store);
}

function setInvestigationName(action$, store) {
        return action$
            .ofType(SET_INVESTIGATION_NAME)
            .groupBy(({ id }) => id)
            .mergeMap((actionsById) => actionsById.switchMap(
                            ({ stateKey, falcor, state }) => falcor.set(
                                                $value(`state['${stateKey}']`, state)
                                            ).progressively()
                        ))
            .ignoreElements();
}
