import { SplunkPivot } from './SplunkPivot.js';
import logger from '../../logger.js';
import stringhash from 'string-hash';
const log = logger.createLogger(__filename);

const SPLUNK_INDICES = {
    EVENT_GEN: 'index=event_gen',
    PAN: 'index=event_gen | search vendor="Palo Alto Networks"'
};

const PAN_NODE_COLORS = { 'EventID': 7, 'user': 1, 'dest': 3, 'threat_name': 5 };

const PAN_NODE_SIZES = { 'EventID': 0.1, 'dest': 1.1, 'user': 5, 'threat_name': 10 };

const attributes = [
    'user', 'threat_name', 'action', 'url', 'severity',
    'application', 'filename', 'client_location', 'dest_hostname'
]

const PAN_ENCODINGS = {
    point: {
        pointColor: function(node) {
            node.pointColor = PAN_NODE_COLORS[node.type];
            if (node.pointColor === undefined) {
                node.pointColor = stringhash(node.type) % 12;
            }
        },
        pointSizes: function(node) {
            node.pointSize = PAN_NODE_SIZES[node.type] || 2;
        }
    }
};


export const PAN_SEARCH = new SplunkPivot({
    name: 'PAN - Search',
    id: 'pan-search',
    tags: ['PAN'],
    pivotParameterKeys: ['query', 'nodes'],
    pivotParametersUI: {
        query: {
            inputType: 'text',
            label: 'Search:',
            placeholder: 'severity="critical"'
        },
        nodes: {
            inputType: 'multi',
            label: 'Nodes:',
            options: attributes.map(x => ({id:x, name:x})),
        }
    },
    attributes: attributes,
    encodings: PAN_ENCODINGS,
    toSplunk: function(pivotParameters) {
        this.connections = pivotParameters.nodes.value;
        const query = `search ${SPLUNK_INDICES.PAN} ${pivotParameters.query}
                ${this.constructFieldString()}
                | head 1000`;

        return {
            searchQuery: query,
            searchParams: {earliest_time: '-1y'},
        };
    }
});

const contextFilter = '(severity="critical" OR severity="medium" OR severity="low")';


export const PAN_EXPAND = new SplunkPivot({
    name: 'PAN - Expand',
    id: 'pan-expand',
    tags: ['PAN'],
    pivotParameterKeys: ['source', 'sourceAttribute', 'query', 'nodes'],
    pivotParametersUI: {
        source: {
            inputType: 'pivotCombo',
            label: 'Select events:',
        },
        sourceAttribute: {
            inputType: 'combo',
            label: 'Expand on:',
            options: attributes.map(x => ({value:x, label:x}))
        },
        query: {
            inputType: 'text',
            label: 'Subsearch:',
            placeholder: contextFilter
        },
        nodes: {
            inputType: 'multi',
            label: 'Nodes:',
            options: attributes.map(x => ({id:x, name:x})),
        }
    },
    attributes: attributes,
    encodings: PAN_ENCODINGS,
    toSplunk: function(pivotParameters, pivotCache) {
        this.connections = pivotParameters.nodes.value;
        const sourceAttribute = pivotParameters.sourceAttribute;
        const filter = pivotParameters.query;
        const sourcePivots = pivotParameters.source.value;
        const list  = sourcePivots.map(
            (pivotId) =>
                (`[| loadjob "${pivotCache[pivotId].splunkSearchId}"
                   | fields ${sourceAttribute} | dedup ${sourceAttribute}]`)
        );
        const subsearch = list.join(' | append ');

        const query = `search ${SPLUNK_INDICES.PAN}
                    | search ${filter} ${subsearch} ${this.constructFieldString()}`;

        return {
            searchQuery: query,
            searchParams: {earliest_time: '-1y'},
        };
    },
});
