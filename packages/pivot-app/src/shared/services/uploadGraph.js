import { Observable } from 'rxjs';
import { simpleflake } from 'simpleflakes';
var DataFrame =  require('../Dataframe')
var _ = require('underscore');
var zlib = require('zlib')

var request = require('request');

function upload(etlService, apiKey, data) {
    const upload0Wrapped = Observable.bindNodeCallback(upload0.bind(null));

    if (data.graph.length === 0) {
        return Observable.throw(new Error('No edges to upload!'));
    }
    return upload0Wrapped(etlService, apiKey, data)
        .map(() =>  data.name)
}

//jsonGraph * (err? -> ())? -> ()
function upload0(etlService, apiKey, data, cb) {
    cb = cb || function (err, data) {
        if (err) {
            return console.error('exn', err);
        } else {
            return console.log('success', data);
        }
    };

    const shouldZip = false;
    if (shouldZip) {
        zlib.gzip(new Buffer(JSON.stringify(data), {level : 9 }), (err, buffer) => {
            if (!err) {
                const headers = {'Content-Encoding': 'gzip', 'Content-Type': 'application/json'};
                request.post({
                    uri: etlService,
                    qs: getQuery(apiKey),
                    headers: headers,
                    body: buffer,
                    callback:
                    function (err, resp, body) {
                        const json = JSON.parse(body);
                        if (err) { return cb(err); }
                        try {
                            if (!json.success) {
                                console.log('body in succes?', body);
                                throw new Error(body)
                            }
                            console.log("  -> Uploaded", body);
                            return cb(undefined, body);
                        } catch (e) {
                            return cb(e);
                        }
                    }
                });
            } else {
                return console.log('Errror!');
            }
        })
    } else {
        console.log('Not zipping')
        request.post({
            uri: etlService,
            qs: getQuery(apiKey),
            json: data,
            callback:
            function (err, resp, body) {
                if (err) { return cb(err); }
                try {
                    if (!body.success) {
                        console.log(body);
                        throw new Error(body)
                    }
                    console.log("  -> Uploaded", body);
                    return cb(undefined, body);
                } catch (e) {
                    return cb(e);
                }
            }
        });
    }
}


function getQuery(key) {
    return {
        'key': key,
        'agent': 'pivot-app',
        'agentversion': '0.0.1',
        'apiversion': 1
    };
}


const previousGraph = {
    graph: [],
    labels: []
};


function createGraph(pivots) {
    const name = ("splunkUpload" + simpleflake().toJSON())
    const type = "edgelist";
    const bindings = {
        "sourceField": "source",
        "destinationField": "destination",
        "idField": "node"
    }
    const mergedPivots = {
        graph:[],
        labels: []
    };

    pivots.forEach(pivot => {
        if (pivot.results && pivot.enabled) {
            mergedPivots.graph = [...mergedPivots.graph, ...pivot.results.graph]
            mergedPivots.labels = [...mergedPivots.labels, ...pivot.results.labels];
        }
    });

    // Hack for demo.
    const edges = mergedPivots.graph;
    const seen = {};
    const dedupEdges = edges.filter(({source, destination}) => {
        const isFiltered = seen.hasOwnProperty(JSON.stringify({source, destination})) ?
            false :
            seen[JSON.stringify({source, destination})] = true
        return isFiltered;
    })
    mergedPivots.graph = dedupEdges;

    const newEdges = _.difference(mergedPivots.graph, previousGraph.graph);
    const removedEdges = _.difference(previousGraph.graph, mergedPivots.graph);
    const newNodes = _.difference(mergedPivots.labels, previousGraph.labels);
    const removedNodes = _.difference(previousGraph.labels, mergedPivots.labels);

    DataFrame.addEdges(newEdges);
    DataFrame.removeEdges(removedEdges);
    DataFrame.addNodes(newNodes);
    DataFrame.removeNodes(removedNodes);

    const uploadData = {
        graph: DataFrame.getData().edges,
        labels: DataFrame.getData().nodes,
        name, type, bindings
    };

    previousGraph.graph = uploadData.graph;
    previousGraph.labels = uploadData.labels;

    return uploadData;
}


export function uploadGraph({loadInvestigationsById, loadPivotsById, investigationIds}) {
    return loadInvestigationsById({investigationIds})
        .mergeMap(
            ({app, investigation}) => loadPivotsById({pivotIds: investigation.pivots.map(x => x.value[1])})
                .map(({app, pivot}) => pivot)
                .toArray()
                .map(createGraph)
                .switchMap(data => upload(app.etlService, app.apiKey, data))
                .do((name) => {
                    investigation.url = `${app.vizService}&dataset=${name}`;
                    console.log('  URL: ', investigation.url);
                })
                .catch(e => {
                    investigation.status = {
                        ok: false,
                        message: e.message || 'Unknown Error'
                    };
                    return Observable.of({});
                }),
            ({app, investigation}) => ({app, investigation})
        )
}
