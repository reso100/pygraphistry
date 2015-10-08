#!/usr/bin/env node
'use strict';

//Set jshint to ignore `predef:'io'` in .jshintrc so we can manually define io here
/* global -io */

var Rx          = require('rx');
var _           = require('underscore');
var Q           = require('q');
var fs          = require('fs');
var path        = require('path');
var extend      = require('node.extend');
var dConf       = require('./js/workbook.config.js');
var rConf       = require('./js/renderer.config.js');
var lConf       = require('./js/layout.config.js');
var wbLoader    = require('./js/workbook.js');
var loader      = require('./js/data-loader.js');
var driver      = require('./js/node-driver.js');
var persistor   = require('./js/persist.js');
var labeler     = require('./js/labeler.js');
var vgwriter    = require('./js/libs/VGraphWriter.js');
var compress    = require('node-pigz');
var config      = require('config')();
var util        = require('./js/util.js');
var ExpressionCodeGenerator = require('./js/expressionCodeGenerator');

var log         = require('common/logger.js');
var logger      = log.createLogger('graph-viz:driver:viz-server');
var perf        = require('common/perfStats.js').createPerfMonitor();

/**** GLOBALS ****************************************************/

// ----- BUFFERS (multiplexed over clients) ----------
//Serve most recent compressed binary buffers
//TODO reuse across users
//{socketID -> {buffer...}
var lastCompressedVBOs;
var lastRenderConfig;
var lastMetadata;
var finishBufferTransfers;


// ----- ANIMATION ------------------------------------
//current animation
var animStep;

//multicast of current animation's ticks
var ticksMulti;

//Signal to Explicitly Send New VBOs
var updateVboSubject;

//most recent tick
var graph;

var saveAtEachStep = false;
var defaultSnapshotName = 'snapshot';


// ----- INITIALIZATION ------------------------------------

//Do more innocuous initialization inline (famous last words..)

function resetState(dataset) {
    logger.info('RESETTING APP STATE');

    //FIXME explicitly destroy last graph if it exists?

    lastCompressedVBOs = {};
    lastMetadata = {};
    finishBufferTransfers = {};

    updateVboSubject = new Rx.ReplaySubject(1);

    animStep = driver.create(dataset);
    ticksMulti = animStep.ticks.publish();
    ticksMulti.connect();

    //make available to all clients
    graph = new Rx.ReplaySubject(1);
    ticksMulti.take(1).subscribe(graph, log.makeRxErrorHandler(logger, logger, 'ticksMulti failure'));

    logger.trace('RESET APP STATE.');
}


/**** END GLOBALS ****************************************************/



/** Given an Object with buffers as values, returns the sum size in megabytes of all buffers */
function sizeInMBOfVBOs(VBOs) {
    var vboSizeBytes =
        _.reduce(
            _.pluck(_.values(VBOs.buffers), 'byteLength'),
            function(acc, v) { return acc + v; }, 0);
    return (vboSizeBytes / (1024 * 1024)).toFixed(1);
}

// TODO: Dataframe doesn't currently support sorted/filtered views, so we just do
// a shitty job and manage it directly out here, which is slow + error prone.
// We need to extend dataframe to allow us to have views.
function sliceSelection(dataFrame, type, indices, start, end, sort_by, ascending, searchFilter) {

    if (searchFilter) {
        searchFilter = searchFilter.toLowerCase();
        var newIndices = [];
        _.each(indices, function (idx) {
            var row = dataFrame.getRowAt(idx, type);
            var keep = false;
            _.each(row, function (val/*, key*/) {
                if (String(val).toLowerCase().indexOf(searchFilter) > -1) {
                    keep = true;
                }
            });
            if (keep) {
                newIndices.push(idx);
            }
        });
        indices = newIndices;
    }

    var count = indices.length;

    if (sort_by !== undefined) {

        // TODO: Speed this up / cache sorting. Actually, put this into dataframe itself.
        // Only using permutation out here because this should be pushed into dataframe.
        var sortCol = dataFrame.getColumnValues(sort_by, type);
        var sortToUnsortedIdx = dataFrame.getHostBuffer('forwardsEdges').edgePermutationInverseTyped;
        var taggedSortCol = _.map(indices, function (idx) {
            if (type === 'edge') {
                return [sortCol[sortToUnsortedIdx[idx]], idx];
            } else {
                return [sortCol[idx], idx];
            }

        });

        var sortedTags = taggedSortCol.sort(function (val1, val2) {
            var a = val1[0];
            var b = val2[0];
            if (typeof a === 'string' && typeof b === 'string') {
                return (ascending ? a.localeCompare(b) : b.localeCompare(a));
            } else if (isNaN(a) || a < b) {
                return ascending ? -1 : 1;
            } else if (isNaN(b) || a > b) {
                return ascending ? 1 : -1;
            } else {
                return 0;
            }
        });

        var slicedTags = sortedTags.slice(start, end);
        var slicedIndices = _.map(slicedTags, function (val) {
            return val[1];
        });

        return {count: count, values: dataFrame.getRows(slicedIndices, type)};

    } else {
        return {count: count, values: dataFrame.getRows(indices.slice(start, end), type)};
    }
}

function read_selection(type, query, res) {
    graph.take(1).do(function (graph) {
        graph.simulator.selectNodes(query.sel).then(function (nodeIndices) {
            var edgeIndices = graph.simulator.connectedEdges(nodeIndices);
            return {
                'point': nodeIndices,
                'edge': edgeIndices
            };
        }).then(function (lastSelectionIndices) {
            var page = parseInt(query.page);
            var per_page = parseInt(query.per_page);
            var start = (page - 1) * per_page;
            var end = start + per_page;
            var data = sliceSelection(graph.dataframe, type, lastSelectionIndices[type], start, end,
                                        query.sort_by, query.order === 'asc', query.search);
            res.send(_.extend(data, {
                page: page
            }));
        }).fail(log.makeQErrorHandler(logger, 'read_selection qLastSelectionIndices'));

    }).subscribe(
        _.identity,
        function (err) {
            log.makeRxErrorHandler(logger, 'read_selection handler')(err);
        }
    );
}

function tickGraph (cb) {
    graph.take(1).do(function (graphContent) {
        updateVboSubject.onNext(graphContent);
    }).subscribe(
        _.identity,
        function (err) {
            cb({success: false, error: 'aggregate error'});
            log.makeRxErrorHandler(logger, 'aggregate handler')(err);
        }
    );
}

// Should this be a graph method?
function filterGraphByMaskList(graph, maskList, errors, filters, pointLimit, cb) {
    var masks = graph.dataframe.composeMasks(maskList, pointLimit);

    logger.debug('mask lengths: ', masks.edge.length, masks.point.length);

    // Promise
    var simulator = graph.simulator;
    try {
        graph.dataframe.applyMaskSetToFilterInPlace(masks, simulator)
            .then(function () {
                simulator.layoutAlgorithms
                    .map(function (alg) {
                        return alg.updateDataframeBuffers(simulator);
                    });
            }).then(function () {
                simulator.tickBuffers([
                    'curPoints', 'pointSizes', 'pointColors',
                    'edgeColors', 'logicalEdges', 'springsPos'
                ]);

                tickGraph(cb);
                var response = {success: true, filters: filters};
                if (errors) {
                    response.errors = errors;
                }
                cb(response);
            }).done(_.identity, function (err) {
                log.makeQErrorHandler(logger, 'dataframe filter')(err);
                errors.push(err);
                var response = {success: false, errors: errors, filters: filters};
                cb(response);
            });
    } catch (err) {
        log.makeQErrorHandler(logger, 'dataframe filter')(err);
        errors.push(err);
        var response = {success: false, errors: errors, filters: filters};
        cb(response);
    }
}

function init(app, socket) {
    logger.info('Client connected', socket.id);

    var workbookConfig = {};
    /** @type GraphistryURLParams */
    var query = socket.handshake.query;
    if (query.workbook) {
        logger.debug('Loading workbook', query.workbook);
        var observableLoad = wbLoader.loadDocument(decodeURIComponent(query.workbook));
        observableLoad.do(function (workbookDoc) {
            workbookConfig = _.extend(workbookConfig, workbookDoc);
        }).subscribe(_.identity, function (error) {
            util.makeRxErrorHandler('Loading Workbook')(error);
            // TODO report to user if authenticated and can know of this workbook's existence.
        });
    } else {
        // Create a new workbook here with a default view:
        workbookConfig = _.extend(workbookConfig, {views: {default: {}}});
    }

    // Pick the default view or the current view or any view:
    var viewConfig = workbookConfig.views.default ||
        _.find(workbookConfig.views[workbookConfig.currentview]) ||
        _.find(workbookConfig.views);

    if (!viewConfig.filters) {
        viewConfig.filters = [
            // nodes/edges limited per client render estimate:
            {
                title: 'Point Limit',
                attribute: undefined,
                query: {
                    type: 'point',
                    ast: {
                        type: 'Limit',
                        value: {
                            type: 'Literal',
                            dataType: 'integer',
                            value: 8e5
                        }
                    },
                    inputString: 'LIMIT 800000'
                }
            }
        ];
    }

    // Apply approved URL parameters to that view concretely since we're creating it now:
    _.extend(query, _.pick(viewConfig, dConf.URLParamsThatPersist));

    var colorTexture = new Rx.ReplaySubject(1);
    var imgPath = path.resolve(__dirname, 'test-colormap2.rgba');
    var img =
        Rx.Observable.fromNodeCallback(fs.readFile)(imgPath)
        .flatMap(function (buffer) {
            logger.trace('Loaded raw colorTexture', buffer.length);
            return Rx.Observable.fromNodeCallback(compress.deflate)(
                    buffer,//binary,
                    {output: new Buffer(
                        Math.max(1024, Math.round(buffer.length * 1.5)))})
                .map(function (compressed) {
                    return {
                        raw: buffer,
                        compressed: compressed
                    };
                });
        })
        .do(function () { logger.trace('Compressed color texture'); })
        .map(function (pair) {
            logger.trace('colorMap bytes', pair.raw.length);
            return {
                buffer: pair.compressed[0],
                bytes: pair.raw.length,
                width: 512,
                height: 512
            };
        });

    img.take(1)
        .do(colorTexture)
        .subscribe(_.identity, log.makeRxErrorHandler(logger, 'img/texture'));
    colorTexture
        .do(function() { logger.trace('HAS COLOR TEXTURE'); })
        .subscribe(_.identity, log.makeRxErrorHandler(logger, 'colorTexture'));



    app.get('/vbo', function (req, res) {
        logger.info('VBOs: HTTP GET %s', req.originalUrl);
        // performance monitor here?
        // profiling.debug('VBO request');

        try {
            // TODO: check that query parameters are present, and that given id, buffer exist
            var bufferName = req.query.buffer;
            var id = req.query.id;

            res.set('Content-Encoding', 'gzip');
            var VBOs = lastCompressedVBOs[id];
            if (VBOs) {
                res.send(lastCompressedVBOs[id][bufferName]);
            }
            res.send();

            finishBufferTransfers[id](bufferName);
        } catch (e) {
            log.makeQErrorHandler(logger, 'bad /vbo request')(e);
        }
    });

    app.get('/texture', function (req, res) {
        logger.debug('got texture req', req.originalUrl, req.query);
        try {
            colorTexture.pluck('buffer').do(
                function (data) {
                    res.set('Content-Encoding', 'gzip');
                    res.send(data);
                })
                .subscribe(_.identity, log.makeRxErrorHandler(logger, 'colorTexture pluck'));

        } catch (e) {
            log.makeQErrorHandler(logger, 'bad /texture request')(e);
        }
    });


    app.get('/read_node_selection', function (req, res) {
        logger.debug('Got read_node_selection', req.query);
        read_selection('point', req.query, res);
    });

    app.get('/read_edge_selection', function (req, res) {
        logger.debug('Got read_edge_selection', req.query);
        read_selection('edge', req.query, res);
    });

    // Get the dataset name from the query parameters, may have been loaded from view:
    var qDataset = loader.downloadDataset(query);

    var qRenderConfig = qDataset.then(function (dataset) {
        var metadata = dataset.metadata;

        if (!(metadata.scene in rConf.scenes)) {
            logger.warn('WARNING Unknown scene "%s", using default', metadata.scene);
            metadata.scene = 'default';
        }

        resetState(dataset);
        return rConf.scenes[metadata.scene];
    }).fail(log.makeQErrorHandler(logger, 'resetting state'));

    socket.on('render_config', function(_, cb) {
        qRenderConfig.then(function (renderConfig) {
            logger.info('renderConfig', renderConfig);
            logger.trace('Sending render-config to client');
            cb({success: true, renderConfig: renderConfig});

            if (saveAtEachStep) {
                persistor.saveConfig(defaultSnapshotName, renderConfig);
            }

            lastRenderConfig = renderConfig;
        }).fail(function (err) {
            cb({success: false, error: 'Render config read error'});
            log.makeQErrorHandler(logger, 'sending render_config')(err);
        });
    });

    socket.on('update_render_config', function(newValues, cb) {
        qRenderConfig.then(function (renderConfig) {
            logger.info('renderConfig [before]', renderConfig);
            logger.trace('Updating render-config from client values');

            extend(true, renderConfig, newValues);

            cb({success: true, renderConfig: renderConfig});

            if (saveAtEachStep) {
                persistor.saveConfig(defaultSnapshotName, renderConfig);
            }

            lastRenderConfig = renderConfig;
        }).fail(function (err) {
            cb({success: false, error: 'Render config update error'});
            log.makeQErrorHandler(logger, 'updating render_config')(err);
        });
    });

    socket.on('get_filters', function (ignored, cb) {
        logger.trace('sending current filters to client');
        cb({success: true, filters: viewConfig.filters});
    });

    socket.on('update_filters', function (newValues, cb) {
        logger.trace('updating filters from client values');
        // Maybe direct assignment isn't safe, but it'll do for now.
        viewConfig.filters = newValues;
        logger.info('filters', viewConfig.filters);

        graph.take(1).do(function (graph) {
            var dataframe = graph.dataframe;
            var maskList = [];
            var errors = [];
            var pointLimit = Infinity;

            _.each(viewConfig.filters, function (filter) {
                if (filter.enabled === false) {
                    return;
                }
                /** @type ClientQuery */
                var filterQuery = filter.query;
                var masks;
                if (filterQuery === undefined) {
                    return;
                }
                var ast = filterQuery.ast;
                if (ast !== undefined &&
                    ast.type === 'Limit' &&
                    ast.value !== undefined) {
                    var generator = new ExpressionCodeGenerator('javascript');
                    pointLimit = generator.evaluateExpressionFree(ast.value);
                    return;
                }
                var type = filter.type || filterQuery.type;
                var attribute = filter.attribute || filterQuery.attribute;
                var normalization = dataframe.normalizeAttributeName(filterQuery.attribute, type);
                if (normalization === undefined) {
                    errors.push('Unknown frame element');
                    return;
                } else {
                    type = normalization.type;
                    attribute = normalization.attribute;
                }
                if (type === 'point') {
                    var pointMask = dataframe.getPointAttributeMask(attribute, filterQuery);
                    masks = dataframe.masksFromPoints(pointMask);
                } else if (type === 'edge') {
                    var edgeMask = dataframe.getEdgeAttributeMask(attribute, filterQuery);
                    masks = dataframe.masksFromEdges(edgeMask);
                } else {
                    errors.push('Unknown frame element type');
                    return;
                }
                // Record the size of the filtered set for UI feedback:
                filter.maskSizes = {point: masks.numPoints(), edge: masks.numEdges()};
                maskList.push(masks);
            });

            filterGraphByMaskList(graph, maskList, errors, viewConfig.filters, pointLimit, cb);
        }).subscribe(
            _.identity,
            function (err) {
                log.makeRxErrorHandler(logger, 'update_filters handler')(err);
            }
        );
    });

    socket.on('layout_controls', function(_, cb) {
        logger.info('Sending layout controls to client');

        graph.take(1).do(function (graph) {
            logger.info('Got layout controls');
            var controls = graph.simulator.controls;
            cb({success: true, controls: lConf.toClient(controls.layoutAlgorithms)});
        })
        .subscribeOnError(function (err) {
            logger.error(err, 'Error sending layout_controls');
            cb({success: false, error: 'Server error when fetching controls'});
            throw err;
        });
    });

    socket.on('begin_streaming', function() {
        qRenderConfig.then(function (renderConfig) {
            stream(socket, renderConfig, colorTexture);
        }).fail(log.makeQErrorHandler(logger, 'streaming'));
    });

    socket.on('reset_graph', function (_, cb) {
        logger.info('reset_graph command');
        qDataset.then(function (dataset) {
            resetState(dataset);
            cb();
        }).fail(log.makeQErrorHandler(logger, 'reset graph request'));
    });

    socket.on('inspect_header', function (nothing, cb) {
        logger.info('inspect header');
        graph.take(1).do(function (graph) {
            cb({
                success: true,
                header: {
                    nodes: graph.dataframe.getAttributeKeys('point'),
                    edges: graph.dataframe.getAttributeKeys('edge')
                },
                urns: {
                    nodes: 'read_node_selection',
                    edges: 'read_edge_selection'
                }
            });
        }).subscribe(
            _.identity,
            function (err) {
                cb({success: false, error: 'inspect_header error'});
                log.makeRxErrorHandler(logger, 'inspect_header handler')(err);
            }
        );
    });

    function getNamespaceFromGraph(graph) {
        var dataframeColumnsByType = graph.dataframe.getColumnsByType();
        // TODO add special names that can be used in calculation references.
        // TODO handle multiple sources.
        var metadata = _.extend({}, dataframeColumnsByType);
        return metadata;
    }

    /** Implements/gets a namespace comprehension, for calculation references and metadata. */
    socket.on('get_namespace_metadata', function (nothing, cb) {
        logger.trace('Sending Namespace metadata to client');
        graph.take(1).do(function (graph) {
            var metadata = getNamespaceFromGraph(graph);
            cb({success: true,
                metadata: metadata});
        }).subscribe(
            _.identity,
            function (err) {
                cb({success: false, error: 'Namespace metadata error'});
                log.makeQErrorHandler(logger, 'sending namespace metadata')(err);
            }
        );
    });

    socket.on('update_namespace_metadata', function (updates, cb) {
        logger.trace('Updating Namespace metadata from client');
        graph.take(1).do(function (graph) {
            var metadata = getNamespaceFromGraph(graph);
            // set success to true when we support update and it succeeds:
            cb({success: false, metadata: metadata});
        }).fail(function (/*err*/) {
            cb({success: false, error: 'Namespace metadata update error'});
            log.makeQErrorHandler(logger, 'updating namespace metadata');
        });
    });

    socket.on('filter', function (query, cb) {
        logger.info('Got filter', query);
        graph.take(1).do(function (graph) {

            var maskList = [];
            var errors = [];

            var dataframe = graph.dataframe;
            _.each(query, function (data, attribute) {
                var masks;
                var type = data.type;
                var normalization = dataframe.normalizeAttributeName(attribute, type);
                if (normalization === undefined) {
                    errors.push(Error('No attribute found for: ' + attribute + ',' + type));
                    cb({success: false, errors: errors});
                    return;
                } else {
                    type = normalization.type;
                    attribute = normalization.attribute;
                }
                if (type === 'point') {
                    var pointMask = dataframe.getPointAttributeMask(attribute, data);
                    masks = dataframe.masksFromPoints(pointMask);
                } else if (type === 'edge') {
                    var edgeMask = dataframe.getEdgeAttributeMask(attribute, data);
                    masks = dataframe.masksFromEdges(edgeMask);
                } else {
                    errors.push('Unrecognized type: ' + type);
                    cb({success: false, errors: errors});
                    return;
                }
                maskList.push(masks);
            });
            filterGraphByMaskList(graph, maskList, errors, viewConfig.filters, Infinity, cb);
        }).subscribe(
            _.identity,
            function (err) {
                log.makeRxErrorHandler(logger, 'aggregate handler')(err);
            }
        );
    });

    var aggregateRequests = new Rx.Subject().controlled(); // Use pull model.

    //query :: {attributes: ??, binning: ??, mode: ??, type: 'point' + 'edge'}
    // -> {success: false} + {success: true, data: ??}
    socket.on('aggregate', function (query, cb) {
        logger.info('Got aggregate', query);

        graph.take(1).do(function (graph) {
            logger.trace('Selecting Indices');
            var qIndices;

            if (query.all === true) {
                var numPoints = graph.simulator.dataframe.getNumElements('point');
                qIndices = Q(new Uint32Array(_.range(numPoints)));
            } else if (!query.sel) {
                qIndices = Q(new Uint32Array([]));
            } else {
                qIndices = graph.simulator.selectNodes(query.sel);
            }

            aggregateRequests.subject.onNext({
                qIndices: qIndices,
                graph: graph,
                query: query,
                cb: cb
            });

        }).subscribe(
            _.identity,
            function (err) {
                cb({success: false, error: 'aggregate socket error'});
                log.makeRxErrorHandler(logger, 'aggregate socket handler')(err);
            }
        );
    });

    var processAggregateIndices = function (request, nodeIndices) {
        var graph = request.graph;
        var cb = request.cb;
        var query = request.query;

        logger.debug('Done selecting indices');
        try {
            var edgeIndices = graph.simulator.connectedEdges(nodeIndices);
            var indices = {
                point: nodeIndices,
                edge: edgeIndices
            };
            var data;

            // Initial case of getting global Stats
            // TODO: Make this match the same structure, not the current approach in StreamGL
            if (query.type) {
                data = [function () {return graph.dataframe.aggregate(graph.simulator, indices[query.type], query.attributes, query.binning, query.mode, query.type);}];
            } else {
                var types = ['point', 'edge'];
                data = _.map(types, function (type) {
                    var filteredAttributes = _.filter(query.attributes, function (attr) {
                        return (attr.type === type);
                    });
                    var attributeNames = _.pluck(filteredAttributes, 'name');
                    var func = function () {
                        return graph.dataframe.aggregate(graph.simulator, indices[type], attributeNames, query.binning, query.mode, type);
                    };
                    return func;
                });
            }

            return util.chainQAll(data).spread(function () {
                var returnData = {};
                _.each(arguments, function (partialData) {
                    _.extend(returnData, partialData);
                });
                logger.debug('Sending back aggregate data');
                cb({success: true, data: returnData});
            });

        } catch (err) {
            cb({success: false, error: err.message, stack: err.stack});
            log.makeRxErrorHandler(logger,'aggregate inner handler')(err);
        }
    };

    // Handle aggregate requests. Fully handle one before moving on to the next.
    aggregateRequests.do(function (request) {
        request.qIndices.then(processAggregateIndices.bind(null, request))
            .then(function () {
                aggregateRequests.request(1);
            }).done(_.identity, log.makeQErrorHandler(logger, 'AggregateIndices Q'));
    }).subscribe(_.identity, log.makeRxErrorHandler(logger, 'aggregate request loop'));
    aggregateRequests.request(1); // Always request first.


    return module.exports;
}

function stream(socket, renderConfig, colorTexture) {

    // ========== BASIC COMMANDS

    lastCompressedVBOs[socket.id] = {};
    socket.on('disconnect', function () {
        logger.info('disconnecting', socket.id);
        delete lastCompressedVBOs[socket.id];
    });



    //Used for tracking what needs to be sent
    //Starts as all active, and as client caches, whittles down
    var activeBuffers = _.chain(renderConfig.models).pairs().filter(function (pair) {
        var model = pair[1];
        return rConf.isBufServerSide(model);
    }).map(function (pair) {
        return pair[0];
    }).value();

    var activeTextures = _.chain(renderConfig.textures).pairs().filter(function (pair) {
        var texture = pair[1];
        return rConf.isTextureServerSide(texture);
    }).map(function (pair) {
        return pair[0];
    }).value();

    var activePrograms = renderConfig.render;



    var requestedBuffers = activeBuffers,
        requestedTextures = activeTextures;

    //Knowing this helps overlap communication and computations
    socket.on('planned_binary_requests', function (request) {
        logger.debug('CLIENT SETTING PLANNED REQUESTS', request.buffers, request.textures);
        requestedBuffers = request.buffers;
        requestedTextures = request.textures;
    });


    logger.debug('active buffers/textures/programs', activeBuffers, activeTextures, activePrograms);


    socket.on('interaction', function (payload) {
        // performance monitor here?
        // profiling.trace('Got Interaction');
        logger.trace('Got interaction:', payload);
        // TODO: Find a way to avoid flooding main thread waiting for GPU ticks.
        var defaults = {play: false, layout: false};
        animStep.interact(_.extend(defaults, payload || {}));
    });

    socket.on('get_labels', function (query, cb) {

        var indices = query.indices;
        var dim = query.dim;

        graph.take(1)
            .map(function (graph) {
                return labeler.getLabels(graph, indices, dim);
            })
            .do(function (out) {
                cb(null, out);
            })
            .subscribe(
                _.identity,
                function (err) {
                    cb('get_labels error');
                    log.makeRxErrorHandler(logger, 'get_labels')(err);
                });
    });

    socket.on('shortest_path', function (pair) {
        graph.take(1)
            .do(function (graph) {
                graph.simulator.highlightShortestPaths(pair);
                animStep.interact({play: true, layout: true});
            })
            .subscribe(_.identity, log.makeRxErrorHandler(logger, 'shortest_path'));
    });

    socket.on('set_colors', function (color) {
        graph.take(1)
            .do(function (graph) {
                graph.simulator.setColor(color);
                animStep.interact({play: true, layout: false});
            })
            .subscribe(_.identity, log.makeRxErrorHandler(logger, 'set_colors'));
    });

    socket.on('highlight_points', function (points) {
        graph.take(1)
            .do(function (graph) {

                points.forEach(function (point) {
                    graph.simulator.dataframe.getLocalBuffer('pointColors')[point.index] = point.color;
                    // graph.simulator.buffersLocal.pointColors[point.index] = point.color;
                });
                graph.simulator.tickBuffers(['pointColors']);

                animStep.interact({play: true, layout: true});
            })
            .subscribe(_.identity, log.makeRxErrorHandler(logger, 'highlighted_points'));

    });

    socket.on('persist_current_vbo', function(contentKey, cb) {
        graph.take(1)
            .do(function (graph) {
                var VBOs = lastCompressedVBOs[socket.id];
                var metadata = lastMetadata[socket.id];
                var cleanContentKey = encodeURIComponent(contentKey);
                persistor.publishStaticContents(cleanContentKey, VBOs, metadata, graph.dataframe, renderConfig).then(function() {
                    cb({success: true, name: cleanContentKey});
                }).done(
                    _.identity,
                    log.makeQErrorHandler(logger, 'persist_current_vbo')
                );
            })
            .subscribe(_.identity, log.makeRxErrorHandler(logger, 'persist_current_vbo'));
    });

    socket.on('persist_upload_png_export', function(pngDataURL, contentKey, imageName, cb) {
        imageName = imageName || 'preview.png';
        graph.take(1)
            .do(function (/*graph*/) {
                var cleanContentKey = encodeURIComponent(contentKey),
                    cleanImageName = encodeURIComponent(imageName),
                    base64Data = pngDataURL.replace(/^data:image\/png;base64,/,""),
                    binaryData = new Buffer(base64Data, 'base64');
                persistor.publishPNGToStaticContents(cleanContentKey, cleanImageName, binaryData).then(function() {
                    cb({success: true, name: cleanContentKey});
                }).done(
                    _.identity,
                    log.makeQErrorHandler(logger, 'persist_upload_png_export')
                );
            })
            .subscribe(_.identity, log.makeRxErrorHandler(logger, 'persist_upload_png_export'));
    });

    socket.on('fork_vgraph', function (name, cb) {
        graph.take(1)
            .do(function (graph) {
                var vgName = 'Users/' + encodeURIComponent(name);
                vgwriter.save(graph, vgName).then(function () {
                    cb({success: true, name: vgName});
                }).done(
                    _.identity,
                    log.makeQErrorHandler(logger, 'fork_vgraph')
                );
            })
            .subscribe(_.identity, function (err) {
                cb({success: false, error: 'fork_vgraph error'});
                log.makeRxErrorHandler(logger, 'fork_vgraph error')(err);
            });
    });






    // ============= EVENT LOOP

    //starts true, set to false whenever transfer starts, true again when ack'd
    var clientReady = new Rx.ReplaySubject(1);
    clientReady.onNext(true);
    socket.on('received_buffers', function (time) {
        perf.gauge('graph-viz:driver:viz-server, client end-to-end time', time);
        logger.trace('Client end-to-end time', time);
        clientReady.onNext(true);
    });

    clientReady.subscribe(logger.debug.bind(logger, 'CLIENT STATUS'), log.makeRxErrorHandler(logger, 'clientReady'));

    logger.trace('SETTING UP CLIENT EVENT LOOP ===================================================================');
    var step = 0;
    var lastVersions = null;

    graph.expand(function (graph) {
        step++;

        var ticker = {step: step};

        logger.trace('0. Prefetch VBOs', socket.id, activeBuffers, ticker);

        return driver.fetchData(graph, renderConfig, compress,
                                activeBuffers, lastVersions, activePrograms)
            .do(function (vbos) {
                logger.trace('1. prefetched VBOs for xhr2: ' + sizeInMBOfVBOs(vbos.compressed) + 'MB', ticker);

                //tell XHR2 sender about it
                if (!lastCompressedVBOs[socket.id]) {
                    lastCompressedVBOs[socket.id] = vbos.compressed;
                } else {
                    _.extend(lastCompressedVBOs[socket.id], vbos.compressed);
                }
                lastMetadata[socket.id] = {elements: vbos.elements, bufferByteLengths: vbos.bufferByteLengths};

                if (saveAtEachStep) {
                    persistor.saveVBOs(defaultSnapshotName, vbos, step);
                }
            })
            .flatMap(function (vbos) {
                logger.trace('2. Waiting for client to finish previous', socket.id, ticker);
                return clientReady
                    .filter(_.identity)
                    .take(1)
                    .do(function () {
                        logger.trace('2b. Client ready, proceed and mark as processing.', socket.id, ticker);
                        clientReady.onNext(false);
                    })
                    .map(_.constant(vbos));
            })
            .flatMap(function (vbos) {
                logger.trace('3. tell client about availablity', socket.id, ticker);

                //for each buffer transfer
                var clientAckStartTime;
                var clientElapsed;
                var transferredBuffers = [];
                finishBufferTransfers[socket.id] = function (bufferName) {
                    logger.trace('5a ?. sending a buffer', bufferName, socket.id, ticker);
                    transferredBuffers.push(bufferName);
                    //console.log("Length", transferredBuffers.length, requestedBuffers.length);
                    if (transferredBuffers.length === requestedBuffers.length) {
                        logger.trace('5b. started sending all', socket.id, ticker);
                        logger.trace('Socket', '...client ping ' + clientElapsed + 'ms');
                        logger.trace('Socket', '...client asked for all buffers',
                            Date.now() - clientAckStartTime, 'ms');
                    }
                };

                // var emitFnWrapper = Rx.Observable.fromCallback(socket.emit, socket);

                //notify of buffer/texture metadata
                //FIXME make more generic and account in buffer notification status
                var receivedAll = colorTexture.flatMap(function (colorTexture) {
                        logger.trace('4a. unwrapped texture meta', ticker);

                        var textures = {
                            colorMap: _.pick(colorTexture, ['width', 'height', 'bytes'])
                        };

                        //FIXME: should show all active VBOs, not those based on prev req
                        var metadata =
                            _.extend(
                                _.pick(vbos, ['bufferByteLengths', 'elements']),
                                {
                                    textures: textures,
                                    versions: {
                                        buffers: vbos.versions,
                                        textures: {colorMap: 1}},
                                    step: step
                                });
                        lastVersions = vbos.versions;

                        logger.trace('4b. notifying client of buffer metadata', metadata, ticker);
                        //perfmonitor here?
                        // profiling.trace('===Sending VBO Update===');

                        //var emitter = socket.emit('vbo_update', metadata, function (time) {
                            //return time;
                        //});
                        //var observableCallback = Rx.Observable.fromNodeCallback(emitter);
                        //return oberservableCallback;
                        return Rx.Observable.fromCallback(socket.emit.bind(socket))('vbo_update', metadata);
                        //return emitFnWrapper('vbo_update', metadata);

                    }).do(
                        function (clientElapsedMsg) {
                            logger.trace('6. client all received', socket.id, ticker);
                            clientElapsed = clientElapsedMsg;
                            clientAckStartTime = Date.now();
                        });

                return receivedAll;
            })
            .flatMap(function () {
                logger.trace('7. Wait for next anim step', socket.id, ticker);

                var filteredUpdateVbo = updateVboSubject.filter(function (data) {
                    return data;
                });

                return ticksMulti.merge(filteredUpdateVbo)
                    .take(1)
                    .do(function (data) {
                        // Mark that we don't need to send vbos independently of ticks anymore.
                        updateVboSubject.onNext(false);
                    })
                    .do(function () { logger.trace('8. next ready!', socket.id, ticker); });
            })
            .map(_.constant(graph));
    })
    .subscribe(function () {
        logger.trace('9. LOOP ITERATED', socket.id);
    }, log.makeRxErrorHandler(logger, 'Main loop failure'));
}


if (require.main === module) {

    var url     = require('url');

    var express = require('express');
    var proxy   = require('express-http-proxy');

    var app     = express();
    var http    = require('http').Server(app);
    var io      = require('socket.io')(http, {path: '/worker/3000/socket.io'});

    // Tell Express to trust reverse-proxy connections from localhost, linklocal, and private IP ranges.
    // This allows Express to expose the client's real IP and protocol, not the proxy's.
    app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

    // debug('Config set to %j', config); //Only want config to print once, which happens when logger is initialized

    var nocache = function (req, res, next) {
        res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.header('Expires', '-1');
        res.header('Pragma', 'no-cache');
        next();
    };
    app.use(nocache);

    var allowCrossOrigin = function  (req, res, next) {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type,Authorization');
        res.header('Access-Control-Allow-Methods', 'GET,PUT,PATCH,POST,DELETE');
        next();
    };
    app.use(allowCrossOrigin);

    //Static assets
    app.get('*/StreamGL.js', function(req, res) {
        res.sendFile(require.resolve('StreamGL/dist/StreamGL.js'));
    });
    app.get('*/StreamGL.map', function(req, res) {
        res.sendFile(require.resolve('StreamGL/dist/StreamGL.map'));
    });
    app.use('/graph', function (req, res, next) {
        return express.static(path.resolve(__dirname, 'assets'))(req, res, next);
    });

    //Dyn routing
    app.get('/vizaddr/graph', function(req, res) {
        res.json({
            'hostname': config.HTTP_LISTEN_ADDRESS,
            'port': config.HTTP_LISTEN_PORT,
            'timestamp': Date.now()
        });
    });

    io.on('connection', function (socket) {
        init(app, socket);
        socket.on('viz', function (msg, cb) { cb({success: true}); });
    });

    logger.info('Binding', config.HTTP_LISTEN_ADDRESS, config.HTTP_LISTEN_PORT);
    var listen = Rx.Observable.fromNodeCallback(
            http.listen.bind(http, config.HTTP_LISTEN_PORT, config.HTTP_LISTEN_ADDRESS))();

    listen.do(function () {

        //proxy worker requests
        var from = '/worker/' + config.HTTP_LISTEN_PORT + '/';
        var to = 'http://localhost:' + config.HTTP_LISTEN_PORT;
        logger.info('setting up proxy', from, '->', to);
        app.use(from, proxy(to, {
            forwardPath: function(req/*, res*/) {
                return url.parse(req.url).path.replace(new RegExp('worker/' + config.HTTP_LISTEN_PORT + '/'),'/');
            }
        }));



    }).subscribe(
        function () { logger.info('\nViz worker listening...'); },
        log.makeRxErrorHandler(logger, 'server-viz main')
    );

}


module.exports = {
    init: init
};
