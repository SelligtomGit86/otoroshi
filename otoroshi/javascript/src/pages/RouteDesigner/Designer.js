import React, { useEffect, useRef, useState } from 'react';
import { useParams, useLocation } from 'react-router';
import {
  nextClient,
  getCategories,
  getPlugins,
  getOldPlugins,
} from '../../services/BackOfficeServices';
import {
  DEFAULT_FLOW,
  EXCLUDED_PLUGINS,
  LEGACY_PLUGINS_WRAPPER,
  PLUGIN_INFORMATIONS_SCHEMA,
} from './Graph';
import Loader from './Loader';
import { isEqual } from "lodash";
import { toUpperCaseLabels, camelToSnake, camelToSnakeFlow, REQUEST_STEPS_FLOW } from '../../util';
import { Form, type, format, validate } from '@maif/react-forms';
import { CodeInput } from '@maif/react-forms';
import { MarkdownInput } from '@maif/react-forms';
import { FeedbackButton } from './FeedbackButton';
import { merge } from 'lodash';
import { cloneDeep } from 'lodash';

const Status = ({ value }) => (
  <div className="status-dot" title={value ? 'plugin enabled' : 'plugin disabled'} style={{ backgroundColor: value ? '#198754' : '#D5443F' }} />
);

const Legacy = ({ value }) => (
  <div className="legacy-dot" title="legacy plugin" style={{ display: !!value ? 'block' : 'none' }} />
);

const Dot = ({
  className,
  icon,
  children,
  prefix,
  clickable,
  onClick,
  highlighted,
  selectedNode,
  enabled,
  legacy,
  onUp,
  onDown,
  arrows = { up: false, down: false },
  style = {},
}) => (
  <div
    className={`dot ${className}`}
    style={{
      cursor: clickable ? 'pointer' : 'initial',
      opacity: (!selectedNode || highlighted) ? 1 : 0.25,
      backgroundColor: highlighted ? '#f9b000' : '#494948',
      ...style,
    }}
    onClick={(e) => {
      e.stopPropagation();
      if (onClick) onClick(e);
    }}>
    {enabled !== undefined && <Status value={enabled} />}
    {legacy !== undefined && <Legacy value={legacy} />}
    {prefix && prefix}
    {icon && <i className={`fas fa-${icon} dot-icon`} />}
    {children && children}

    {highlighted && <div className='flex flex-column node-cursor'>
      {arrows.up && <i className='fas fa-chevron-up' onClick={onUp} />}
      {arrows.down && <i className='fas fa-chevron-down' onClick={onDown} />}
    </div>}
  </div>
);

const RemoveButton = ({ onRemove }) => {
  return <div onClick={onRemove} className='delete-node-button'>
    <i className='fas fa-times' />
  </div>
}

const NodeElement = ({
  className,
  element,
  setSelectedNode,
  hideLink,
  selectedNode,
  bold,
  disableBorder,
  style,
  enabled,
  onUnsavedChanges,
  onUp,
  onDown,
  onRemove,
  arrows
}) => {
  const { id, name, index, legacy } = element;
  const highlighted =
    selectedNode &&
    selectedNode.id === id &&
    (selectedNode.plugin_multi_inst ? selectedNode.index === index : true);

  return (
    <>
      <Dot
        onUp={onUp}
        onDown={onDown}
        className={className}
        clickable={true}
        selectedNode={selectedNode}
        style={{
          borderWidth: disableBorder ? 0 : 1,
          fontWeight: bold ? 'bold' : 'normal',
          ...style,
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (onUnsavedChanges) onUnsavedChanges(() => setSelectedNode(element));
          else setSelectedNode(element);
        }}
        highlighted={highlighted}
        arrows={arrows}
        legacy={legacy}
        enabled={enabled}>
        <span className="dot-text">{name || id}</span>
        {highlighted && id !== 'Frontend' && id !== 'Backend' && <RemoveButton onRemove={onRemove} />}
      </Dot>
      {!hideLink && <VerticalLine highlighted={!selectedNode} />}
    </>
  );
};

const VerticalLine = ({ highlighted = true, flex }) => (
  <div
    className="vertical-line"
    style={{
      opacity: highlighted ? 1 : 0.25,
      flex: flex ? 1 : 'initial',
    }}
  />
);

export default ({ value }) => {
  const { routeId } = useParams();

  const [backends, setBackends] = useState([]);

  const [categories, setCategories] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [sortedNodes, setSortedNodes] = useState({})
  const [plugins, setPlugins] = useState([]);

  const [selectedNode, setSelectedNode] = useState();
  const [route, setRoute] = useState(value);
  const [originalRoute, setOriginalRoute] = useState(value);

  const [preview, showPreview] = useState({
    enabled: false,
  });
  const [loading, setLoading] = useState(true);
  const [searched, setSearched] = useState('');
  const [expandAll, setExpandAll] = useState(false);
  const [showLegacy, setShowLegacy] = useState((window.localStorage.getItem('io.otoroshi.next.designer.showLegacy') || 'true') === 'true');
  const location = useLocation();

  const [changed, setChanged] = useState(false);

  useEffect(() => {
    setSortedNodes(nodes.reduce((acc, curr) => {
      if (curr.onTargetStream)
        return { ...acc, onTarget: [...acc.onTarget, curr] }
      else if ((curr.plugin_steps || []).some(s => REQUEST_STEPS_FLOW.includes(s)))
        return { ...acc, inBound: [...acc.inBound, curr] }
      else
        return { ...acc, outBound: [...acc.outBound, curr] }
    }, {
      inBound: [],
      onTarget: [],
      outBound: []
    }))
  }, [nodes])

  useEffect(() => {
    Promise.all([
      nextClient.find(nextClient.ENTITIES.BACKENDS),
      nextClient.fetch(nextClient.ENTITIES.ROUTES, routeId),
      getCategories(),
      getPlugins(),
      getOldPlugins(),
      nextClient.form(nextClient.ENTITIES.FRONTENDS),
      nextClient.form(nextClient.ENTITIES.BACKENDS),
    ]).then(([backends, route, categories, plugins, oldPlugins, frontendForm, backendForm]) => {
      const formatedPlugins = [
        ...plugins,
        ...oldPlugins.map((p) => ({
          ...p,
          legacy: true,
        })),
      ]
        .filter(filterSpecificPlugin)
        .map((plugin) => ({
          ...plugin,
          config_schema: toUpperCaseLabels(plugin.config_schema || plugin.configSchema || {}),
          config: plugin.default_config || plugin.defaultConfig,
        }));

      setBackends(backends);
      setCategories([
        ...categories.filter((category) => !['Tunnel', 'Job'].includes(category)),
        'Ancien plugins',
      ]);
      setRoute(route);
      setOriginalRoute(route);

      setPlugins(
        formatedPlugins.map((p) => ({
          ...p,
          selected: p.plugin_multi_inst ? false : route.plugins.find((r) => r.plugin === p.id),
        }))
      );

      setNodes(
        [
          {
            ...DEFAULT_FLOW.Frontend,
            ...frontendForm,
            config_schema: toUpperCaseLabels({
              ...frontendForm.schema,
              ...DEFAULT_FLOW.Frontend.config_schema,
            }),
            config_flow: DEFAULT_FLOW.Frontend.config_flow,
          },
          {
            ...DEFAULT_FLOW.Backend,
            ...backendForm,
            config_schema: toUpperCaseLabels(
              DEFAULT_FLOW.Backend.config_schema(backendForm.schema)
            ),
            config_flow: DEFAULT_FLOW.Backend.config_flow,
          },
          ...route.plugins.map((ref) => ({
            ...formatedPlugins.find(
              (p) => p.id === ref.plugin || p.id === ref.config.plugin
            )
          }))
        ].map((node, i) => ({ ...node, index: i }))
      );

      setLoading(false);
    });
  }, [location.pathname]);

  const filterSpecificPlugin = (plugin) =>
    !plugin.plugin_steps.includes('Sink') &&
    !plugin.plugin_steps.includes('HandlesTunnel') &&
    !['job', 'sink'].includes(plugin.pluginType) &&
    !EXCLUDED_PLUGINS.plugin_visibility.includes(plugin.plugin_visibility) &&
    !EXCLUDED_PLUGINS.ids.includes(plugin.id.replace('cp:', ''));

  const removeNode = e => {
    e.stopPropagation();
    const id = selectedNode.id
    const idx = selectedNode.index

    window.newConfirm(`Are you sure to delete this node ?`).then((ok) => {
      if (ok) {
        setNodes(
          nodes
            .filter((node, i) => !(node.id === id && i === idx))
            .map((node, i) => ({
              ...node,
              index: i,
            }))
        );

        saveChanges({
          ...route,
          plugins: route.plugins.filter((_, i) => i + 2 !== idx),
        });

        setPlugins(
          plugins.map((plugin) => {
            if (plugin.id === id) return { ...plugin, selected: undefined };
            return plugin;
          })
        );
      }
      setSelectedNode(undefined)
    });
  };

  const addNode = (node) => {
    const newNode = {
      ...node,
      index: nodes.length,
    };

    setPlugins(
      plugins.map((p) => {
        if (p.id === newNode.id) p.selected = !p.plugin_multi_inst;
        return p;
      })
    );

    let steps = [...REQUEST_STEPS_FLOW, 'TransformResponse']
    const newPlugin = {
      plugin: newNode.legacy ? LEGACY_PLUGINS_WRAPPER[newNode.pluginType] : newNode.id,
      enabled: node.enabled || true,
      debug: node.debug || false,
      include: node.include || [],
      exclude: node.exclude || [],
      config: {
        ...newNode.config,
        plugin: newNode.legacy ? newNode.id : undefined,
      },
    }

    let hasChanged = false
    const newPlugins = route.plugins.length === 0 ? [newPlugin] : [...route.plugins.flatMap(curr => {
      const shouldSkip = (newPlugin.plugin_steps || []).some(s => s === steps[0])

      if (shouldSkip && !hasChanged) {
        steps = steps.slice(1)
        hasChanged = true
        return [newPlugin, curr]
      } else
        return curr
    })]

    const newRoute = {
      ...route,
      plugins: hasChanged ? newPlugins : [...newPlugins, newPlugin]
    };

    setNodes([...nodes, newNode]);
    setSelectedNode(newNode);
    saveChanges(newRoute);
  };

  const swap = (aIndex, offset) => {
    const a = { ...nodes.find((_, i) => i === aIndex) }

    let possibilities = []

    if ((a.plugin_steps || []).some(s => REQUEST_STEPS_FLOW.includes(s)))
      possibilities = sortedNodes.inBound
    else if (a.onTargetStream)
      possibilities = sortedNodes.onTarget
    else
      possibilities = sortedNodes.outBound

    const aPos = possibilities.findIndex(node => node.index === a.index)
    const b = possibilities.find((_, i) => i === aPos + offset)

    if (b && a && b.index > 1) {
      const changes = { from: 0, to: 0 }
      setNodes(nodes.map((node, i) => {
        if (node.index === a.index) {
          changes.from = i
          return { ...b, index: i }
        }
        else if (node.index === b.index) {
          changes.to = i
          return { ...a, index: i }
        }
        return { ...node, index: i }
      }))

      let sortedPlugins = [...route.plugins]
      sortedPlugins[changes.from - 2] = route.plugins[changes.to - 2]
      sortedPlugins[changes.to - 2] = route.plugins[changes.from - 2]

      saveChanges({
        ...route,
        plugins: sortedPlugins
      })

      setSelectedNode({
        ...selectedNode,
        index: b.index
      })
    }
  }

  const onUp = e => {
    e.stopPropagation()
    if (selectedNode) {
      const { index } = selectedNode
      swap(index, -1)
    }
  }

  const onDown = e => {
    e.stopPropagation()
    if (selectedNode) {
      const { index } = selectedNode
      swap(index, 1)
    }
  }

  const handleSearch = (search) => {
    setSearched(search);
    setPlugins(
      plugins.map((plugin) => ({
        ...plugin,
        filtered: !(plugin.id.toLowerCase().includes(search.toLowerCase()) || plugin.name.toLowerCase().includes(search.toLowerCase())),
      }))
    );
  };

  const updatePlugin = (pluginId, index, item, updatedField) => {
    return saveChanges({
      ...route,
      frontend: updatedField === 'Frontend' ? item.plugin : route.frontend,
      backend: updatedField === 'Backend' ? item.plugin : route.backend,
      plugins: route.plugins.map((plugin, i) => {
        if ((plugin.plugin === pluginId || plugin.config.plugin === pluginId) && i + 2 === index)
          return {
            ...plugin,
            ...item.status,
            config: item.plugin,
          };

        return plugin;
      }),
    });
  };

  const saveChanges = (route) => {
    return nextClient.update(nextClient.ENTITIES.ROUTES, route).then((newRoute) => {
      setOriginalRoute(newRoute);
      setRoute(newRoute);
    });
  };

  const sortInputStream = (arr) =>
    Object.values(
      arr.reduce(
        (acc, node) => {
          if (node.plugin_steps.includes('PreRoute'))
            return {
              ...acc,
              PreRoute: [...acc['PreRoute'], node],
            };
          else if (node.plugin_steps.includes('ValidateAccess'))
            return {
              ...acc,
              ValidateAccess: [...acc['ValidateAccess'], node],
            };
          return {
            ...acc,
            TransformRequest: [...acc['TransformRequest'], node],
          };
        },
        {
          PreRoute: [],
          ValidateAccess: [],
          TransformRequest: [],
        }
      )
    ).flat();

  const inputNodes = sortInputStream(
    nodes.filter((node) =>
      (node.plugin_steps || []).some(s => REQUEST_STEPS_FLOW.includes(s))
    )
  );

  // console.log("NODES", nodes)
  // console.log("ROUTE", route)

  const targetNodes = nodes.filter((node) => node.onTargetStream);
  const outputNodes = nodes.filter((node) =>
    (node.plugin_steps || []).some((s) => ['TransformResponse'].includes(s))
  );

  const onUnsavedChanges = (onConfirm) => {
    if (changed) {
      window
        .newConfirm(`Are you sure to leave this configuration without save your changes ?`)
        .then((ok) => {
          if (ok) onConfirm();
        });
    } else onConfirm();
  };

  const pluginIsEnabled = (value) => {
    const index = nodes.findIndex((p, i) => p.id === value.id && i === value.index)
    return route.plugins[index - 2]?.enabled;
  }

  const renderTranformerResquests = () => {
    let steps = [...REQUEST_STEPS_FLOW]

    return inputNodes.slice(1).map((value, i) => {
      const showStep = (value.plugin_steps || []).every(s => s !== steps[0])

      if (showStep)
        steps = steps.slice(1)

      return <>
        {(showStep || i === 0) && <>
          <span className='badge bg-warning text-dark' style={{ opacity: !selectedNode ? 1 : 0.25 }}>{steps[0]}</span>
          <VerticalLine highlighted={!selectedNode} />
        </>}
        <NodeElement
          onUp={onUp}
          onDown={onDown}
          onUnsavedChanges={onUnsavedChanges}
          enabled={pluginIsEnabled(value)}
          element={value}
          key={`inNodes${i}`}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          isLast={inputNodes.length - 1 === i}
          onRemove={removeNode}
          arrows={showArrows(value)}
        />
      </>
    })
  }

  const showArrows = node => {
    if (!node)
      return { to: false, down: false }

    const possibilities = sortedNodes[node.onTargetStream ? 'onTarget' : (node.plugin_steps || []).some(s => REQUEST_STEPS_FLOW.includes(s)) ? 'inBound' : 'outBound']

    const aPos = possibilities.findIndex(n => n.index === node.index)
    const up = possibilities[aPos - 1]
    const down = possibilities[aPos + 1]

    if (selectedNode && selectedNode.id === node.id)
      console.log(node, aPos, up, down, possibilities)

    return {
      up: up && !['Frontend', 'Backend'].includes(up.id),
      down: down && !['Frontend', 'Backend'].includes(down.id)
    }
  }

  return (
    <Loader loading={loading}>
      <div
        className="h-100 col-12 hide-overflow route-designer"
        onClick={(e) => {
          e.stopPropagation();
          onUnsavedChanges(() => {
            setChanged(false);
            setSelectedNode(undefined);
          });
        }}>
        <div className="plugins-stack-column">
          <div className="elements">
            <div className="plugins-background-bar" />
            <SearchBar handleSearch={handleSearch} />
            <div className='plugins-action-container mb-2'>
              <button type="button" className="btn btn-sm btn-warning text-light plugins-action" style={{ marginRight: 5 }} onClick={(e) => {
                window.localStorage.setItem('io.otoroshi.next.designer.showLegacy', String(!showLegacy));
                setShowLegacy(!showLegacy);
              }}>{showLegacy ? 'Hide legacy plugins' : 'Show legacy plugins'}</button>
              <button type="button" className="btn btn-sm btn-warning text-light plugins-action" onClick={(e) => setExpandAll(!expandAll)}>{expandAll ? 'Collapse all' : 'Expand all'}</button>
            </div>
            <div className="relative-container" id="plugins-stack-container">
              <PluginsStack
                forceOpen={!!searched}
                expandAll={expandAll}
                elements={plugins.filter(plugin => (showLegacy ? true : !plugin.legacy)).reduce(
                  (acc, plugin) => {
                    if (plugin.selected || plugin.filtered) return acc;
                    return acc.map((group) => {
                      if (plugin.plugin_categories.includes(group.group))
                        return {
                          ...group,
                          elements: [...(group.elements || []), plugin],
                        };
                      return group;
                    });
                  },
                  categories.map((category) => ({
                    group: category,
                    elements: [],
                  }))
                )}
                addNode={addNode}
                showPreview={(element) =>
                  showPreview({
                    enabled: true,
                    element,
                  })
                }
                hidePreview={() => showPreview({ ...preview, enabled: false })}
              />
            </div>
          </div>
        </div>
        <div className="relative-container" style={{ flex: 9 }}>
          {preview.enabled ? (
            <EditView
              addNode={addNode}
              hidePreview={() =>
                showPreview({
                  ...preview,
                  enabled: false,
                })
              }
              readOnly={true}
              setRoute={setRoute}
              selectedNode={preview.element}
              setSelectedNode={setSelectedNode}
              updatePlugin={updatePlugin}
              onRemove={removeNode}
              route={route}
              plugins={plugins}
              backends={backends}
            />
          ) : (
            <div className="row h-100 p-2 me-1 flow-container">
              <div className="col-sm-4 pe-3 d-flex flex-column">
                <div className="row" style={{ height: '100%' }}>
                  <div className="col-sm-6 flex-column">
                    <div className="main-view relative-container">
                      <div
                        className="frontend-button"
                        style={{
                          background:
                            (selectedNode && selectedNode.id === 'Frontend') ?
                              'linear-gradient(to right, rgb(249, 176, 0) 55%, transparent 1%)' :
                              'linear-gradient(to right, rgb(73, 73, 72) 55%, transparent 1%)',
                          opacity: (!selectedNode || (selectedNode && selectedNode.id === 'Frontend')) ? 1 : 0.25
                        }}>
                        <i className="fas fa-user frontend-button-icon" />
                      </div>
                      {inputNodes.slice(0, 1).map((value, i) => (
                        <NodeElement
                          onUp={onUp}
                          onDown={onDown}
                          onUnsavedChanges={onUnsavedChanges}
                          className="frontend-container-button"
                          element={value}
                          key={`inNodes${i}`}
                          selectedNode={selectedNode}
                          setSelectedNode={setSelectedNode}
                          isLast={inputNodes.length - 1 === i}
                          bold={true}
                          onRemove={removeNode}
                          arrows={showArrows(value)}
                        />
                      ))}
                      <Dot className="arrow-flow" icon="chevron-down" selectedNode={selectedNode} prefix="request" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }} />
                      <VerticalLine highlighted={!selectedNode} />
                      {renderTranformerResquests(inputNodes.slice(1))}
                      <VerticalLine highlighted={!selectedNode} flex={true} />
                    </div>
                  </div>
                  <div className="col-sm-6 pe-3 flex-column">
                    <div className="main-view">
                      <Dot className="arrow-flow" icon="chevron-up" selectedNode={selectedNode} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>response</Dot>
                      <VerticalLine highlighted={!selectedNode} flex={true} />
                      {outputNodes.map((value, i) => (
                        <NodeElement
                          onUp={onUp}
                          onDown={onDown}
                          onUnsavedChanges={onUnsavedChanges}
                          enabled={pluginIsEnabled(value)}
                          element={value}
                          key={`outNodes${i}`}
                          setSelectedNode={setSelectedNode}
                          selectedNode={selectedNode}
                          isLast={outputNodes.length - 1 === i}
                          onRemove={removeNode}
                          arrows={showArrows(value)}
                        />
                      ))}
                      <VerticalLine highlighted={!selectedNode} />
                      {outputNodes.length > 0 &&
                        <span className='badge bg-warning text-dark' style={{ opacity: !selectedNode ? 1 : 0.25 }}>TransformerResponse</span>}
                      <VerticalLine highlighted={!selectedNode} />
                    </div>
                  </div>
                </div>
                <div
                  className="main-view backend-button"
                  style={{ opacity: !selectedNode ? 1 : (!selectedNode?.onTargetStream ? 0.25 : 1) }}>
                  <i className="fas fa-bullseye backend-icon" />
                  {targetNodes.map((value, i, arr) => (
                    <NodeElement
                      onUp={onUp}
                      onDown={onDown}
                      onUnsavedChanges={onUnsavedChanges}
                      element={value}
                      key={`targetNodes${i}`}
                      selectedNode={(selectedNode && selectedNode.onTargetStream) ? selectedNode : undefined}
                      setSelectedNode={setSelectedNode}
                      hideLink={arr.length - 1 === i}
                      disableBorder={true}
                      bold={true}
                      onRemove={removeNode}
                      arrows={showArrows(value)}
                    />
                  ))}
                </div>
              </div>
              <div className="col-sm-8 relative-container" style={{ paddingRight: 0 }}>
                <UnselectedNode hideText={selectedNode} route={route} />
                {selectedNode && (
                  <EditView
                    saveChanges={saveChanges}
                    setRoute={setRoute}
                    selectedNode={selectedNode}
                    setSelectedNode={setSelectedNode}
                    updatePlugin={updatePlugin}
                    onRemove={removeNode}
                    route={route}
                    plugins={plugins}
                    backends={backends}
                    hidePreview={() =>
                      showPreview({
                        ...preview,
                        enabled: false,
                      })
                    }
                    showUpdateRouteButton={!isEqual(route, originalRoute)}
                    setRef={setChanged}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div >
    </Loader >
  );
};

const Element = ({ element, addNode, showPreview, hidePreview }) => (
  <div
    className="element"
    onClick={(e) => {
      e.stopPropagation();
      showPreview(element);
    }}>
    <div className="d-flex-between element-text">
      <div>
        {element.legacy ? <span className="badge bg-warning text-dark" style={{ marginRight: 5 }}>legacy</span> : ''}
        {element.name.charAt(0).toUpperCase() + element.name.slice(1)}
      </div>
      <i
        className={`fas fa-${element.plugin_multi_inst ? 'plus' : 'arrow-right'} element-arrow`}
        onClick={(e) => {
          e.stopPropagation();
          hidePreview();
          addNode(element);
        }}
      />
    </div>
  </div>
);

const Group = ({ group, elements, addNode, ...props }) => {
  const [open, setOpen] = useState(props.forceOpen);

  useEffect(() => {
    setOpen(props.forceOpen)
  }, [props.forceOpen])

  useEffect(() => {
    setOpen(props.expandAll);
  }, [props.expandAll])

  return (
    <div className="group">
      <div
        className="search-group-header"
        style={{ cursor: 'pointer' }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}>
        <i
          className={`fas fa-chevron-${open ? 'down' : 'right'} ms-3`}
          size={16}
          style={{ color: '#fff' }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        />
        <span style={{ color: '#fff', padding: '10px' }}>
          {group.charAt(0).toUpperCase() + group.slice(1)}
        </span>
      </div>
      {(props.forceOpen || open) && (
        <PluginsStack elements={elements} addNode={addNode} {...props} />
      )}
    </div>
  );
};

const PluginsStack = ({ elements, ...props }) => (
  <div className="plugins-stack">
    {elements.map((element, i) => {
      if (element.group) {
        if (element.elements?.find((e) => !e.default))
          return <Group {...element} key={element.group} {...props} />;
        return null;
      } else return <Element key={`${element.id}${i}`} n={i + 1} element={element} {...props} />;
    })}
  </div>
);

const SearchBar = ({ handleSearch }) => (
  <div className="group">
    <div className="group-header" style={{ alignItems: 'initial' }}>
      <i className="fas fa-search group-icon designer-group-header-icon" />
      <div
        style={{
          paddingLeft: '6px',
          width: '100%',
          // backgroundColor: '#fff',
          display: 'flex',
          alignItems: 'center',
        }}>
        <input
          type="text"
          style={{
            borderWidth: 0,
            padding: '6px 0px 6px 6px',
            width: '100%',
            outline: 'none',
            borderRadius: '4px',
          }}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search the plugin"
        />
      </div>
    </div>
  </div>
);

const read = (value, path) => {
  const keys = path.split('.');
  if (keys.length === 1) return value[path];

  return read(value[keys[0]], keys.slice(1).join('.'));
};

const UnselectedNode = ({ hideText, route }) => {
  if (route && route.frontend && route.backend && !hideText) {
    const frontend = route.frontend;
    const backend = route.backend;
    const allMethods = (frontend.methods && frontend.methods.length > 0) ? frontend.methods.map(m => <span className="badge bg-success">{m}</span>) : [<span className="badge bg-success">ALL</span>];
    return (
      <>
        <div className="d-flex-between dark-background py-2 ps-2">
          <span style={{ fontStyle: 'italic' }}> Start by selecting a plugin to configure it</span>
        </div>
        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontSize: '1.25rem' }}>Frontend</h3>
          <span>this route is exposed on</span>
          <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 10, marginTop: 10, paddingTop: 10, paddingBottom: 10, backgroundColor: '#555', borderRadius: 3 }}>
            {frontend.domains.map(domain => {
              const exact = frontend.exact;
              const end = exact ? '' : (domain.indexOf('/') < 0 ? '/*' : '*');
              const start = 'http://'
              return (
                allMethods.map(method => {
                  return (
                    <div style={{ paddingLeft: 10, paddingRight: 10, display: 'flex', flexDirection: 'row' }}>
                      <div style={{ width: 80 }}>{method}</div><span style={{ fontFamily: 'monospace' }}>{start}{domain}{end}</span>
                    </div>
                  )
                })
              );
            })}
          </div>
          {frontend.query && Object.keys(frontend.query).length > 0 && (
            <div className="">
              <span>this route will match only if the following query params are present</span>
              <pre style={{ padding: 10, marginTop: 10, backgroundColor: '#555', fontFamily: 'monospace', borderRadius: 3 }}>
                <code>
                  {Object.keys(frontend.query).map(key => `${key}: ${frontend.query[key]}`).join('\n')}
                </code>
              </pre>
            </div>
          )}
          {frontend.headers && Object.keys(frontend.headers).length > 0 && (
            <div className="">
              <span>this route will match only if the following headers are present</span>
              <pre style={{ padding: 10, marginTop: 10, backgroundColor: '#555', fontFamily: 'monospace', borderRadius: 3 }}>
                <code>
                  {Object.keys(frontend.headers).map(key => `${key}: ${frontend.headers[key]}`).join('\n')}
                </code>
              </pre>
            </div>
          )}
        </div>
        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontSize: '1.25rem' }}>Backend</h3>
          <span>this route will forward requests to</span>
          <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 10, marginTop: 10, paddingTop: 10, paddingBottom: 10, backgroundColor: '#555', borderRadius: 3 }}>
            {backend.targets.map(target => {
              const path = backend.root;
              const rewrite = backend.rewrite;
              const hostname = target.ip_address ? `${target.hostname}@${target.ip_address}` : target.hostname;
              const end = (rewrite || frontend.strip_path) ? path : `/<request_path>${path}`;
              const start = target.tls ? 'https://' : 'http://'
              const mtls = (target.tls_config && target.tls_config.enabled && ([...target.tls_config.certs, ...target.tls_config.trusted_certs].length > 0)) ? <span className="badge bg-warning text-dark" style={{ marginRight: 10 }}>mTLS</span> : <span></span>;
              return (
                <div style={{ paddingLeft: 10, paddingRight: 10, display: 'flex', flexDirection: 'row' }}>
                  <span style={{ fontFamily: 'monospace' }}>{mtls}{start}{hostname}:{target.port}{end}</span>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  } else {
    return null;
  }
}

const convertTransformer = (obj) => {
  return Object.entries(obj).reduce((acc, [key, value]) => {
    let newValue = value;
    if (key === 'transformer' && typeof value === 'object')
      newValue = (item) => ({ label: item[value.label], value: item[value.value] });
    else if (typeof value === 'object' && value !== null && !Array.isArray(value))
      newValue = convertTransformer(value);

    return {
      ...acc,
      [key]: newValue,
    };
  }, {});
};

function EditView({
  selectedNode,
  setSelectedNode,
  route,
  onRemove,
  plugins,
  updatePlugin,
  setRoute,
  backends,
  readOnly,
  addNode,
  hidePreview,
  showUpdateRouteButton,
  saveChanges,
  setRef,
}) {
  const [usingExistingBackend, setUsingExistingBackend] = useState(route.backend_ref);
  const [asJsonFormat, toggleJsonFormat] = useState(selectedNode.legacy || readOnly);
  const [form, setForm] = useState({
    schema: {},
    flow: [],
    value: undefined,
  });
  const [backendConfigRef, setBackendConfigRef] = useState();
  const formRef = useRef();

  const [offset, setOffset] = useState(0);
  const [errors, setErrors] = useState([]);
  const [isDirty, setDirty] = useState(showUpdateRouteButton);

  useEffect(() => {
    setDirty(showUpdateRouteButton);
  }, [showUpdateRouteButton]);

  useEffect(() => {
    if (setRef && typeof setRef === 'function') setRef(isDirty);
  }, [isDirty]);

  useEffect(() => {
    const onScroll = () => setOffset(window.pageYOffset);
    window.removeEventListener('scroll', onScroll);
    window.addEventListener('scroll', onScroll, { passive: true });

    onScroll();

    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    if (route.backend_ref)
      nextClient.fetch(nextClient.ENTITIES.BACKENDS, route.backend_ref).then(setBackendConfigRef);
  }, [route.backend_ref]);

  const { id, flow, config_flow, config_schema, schema, name, index } = selectedNode;

  const isFrontendOrBackend = ['Backend', 'Frontend'].includes(id);
  const isPluginWithConfiguration = Object.keys(config_schema).length > 0;

  const plugin =
    isFrontendOrBackend ?
      DEFAULT_FLOW[id] :
      plugins.find((element) => element.id === id || element.id.endsWith(id))

  useEffect(() => {
    let formSchema = schema || config_schema;
    let formFlow = [
      isFrontendOrBackend ? undefined : 'status',
      isPluginWithConfiguration ?
        {
          label: isFrontendOrBackend ? null : 'Plugin',
          flow: ['plugin'],
          collapsed: false,
          collapsable: false,
        } :
        undefined
      ,
    ].filter((f) => f);

    if (config_schema) {
      formSchema = {
        status: {
          type: type.object,
          format: format.form,
          collapsable: true,
          collapsed: isPluginWithConfiguration,
          label: 'Informations',
          schema: PLUGIN_INFORMATIONS_SCHEMA
        },
      };
      if (isPluginWithConfiguration)
        formSchema = {
          ...formSchema,
          plugin: {
            type: type.object,
            format: format.form,
            label: null,
            schema: { ...convertTransformer(config_schema) },
            flow: [...(config_flow || flow)].map((step) => camelToSnakeFlow(step)),
          },
        };
    }

    formSchema = camelToSnake(formSchema);
    formFlow = formFlow.map((step) => camelToSnakeFlow(step));

    let value = route[selectedNode.field];

    if (!value) {
      const node =
        route.plugins.find(
          (p, i) => (p.plugin === id || p.config.plugin === id) && i + 2 === index
        ) || plugins.find((p) => p.id === id);
      if (node)
        value = {
          plugin: node.config,
          status: {
            enabled: node.enabled !== undefined ? node.enabled : true,
            debug: node.debug !== undefined ? node.debug : false,
            include: node.include !== undefined ? node.include : [],
            exclude: node.exclude !== undefined ? node.exclude : [],
          },
        };
    } else {
      value = {
        plugin: { ...value },
      };
    }

    setForm({
      schema: formSchema,
      flow: formFlow,
      value,
      originalValue: value,
    });

    toggleJsonFormat(selectedNode.legacy || readOnly);
  }, [selectedNode.id, selectedNode.index]);

  const onValidate = (item) => {
    const newValue = unstringify(item);
    return updatePlugin(
      id,
      index,
      {
        plugin: newValue.plugin,
        status: newValue.status,
      },
      selectedNode.id
    ).then(() => {
      setForm({ ...form, value: newValue, originalValue: newValue });
      setDirty(false);
    });
  };

  const onJsonInputChange = (value) => {
    validate([], form.schema, value)
      .then((v) => {
        setErrors([]);
        const originalClonedValue = cloneDeep(form.originalValue)
        delete originalClonedValue.plugin.plugin

        setDirty(!isEqual(originalClonedValue, v));
        setForm({ ...form, value: merge(form.originalValue, v) });
        // console.log("onJsonInputChange", originalClonedValue, v, merge(form.originalValue, v))
      })
      .catch((err) => {
        if (err.inner && Array.isArray(err.inner)) {
          setErrors(err.inner.map((r) => r.message));
          setDirty(false);
        }
      });
  };

  if (Object.keys(form.schema).length === 0 || !form.value) return null;

  // console.log("SCHEMA", form.schema)
  // console.log("VALUE", unstringify(form.value))

  return (
    <>
      <div
        id="form"
        onClick={(e) => e.stopPropagation()}
        className="plugins-stack editor-view"
        style={{ top: offset }}>
        <div className="group-header d-flex-between editor-view-informations">
          <div className="d-flex-between">
            <i
              className={`fas fa-${plugin.icon || 'bars'
                } group-icon designer-group-header-icon editor-view-icon`}
            />
            <span className="editor-view-text">{name || id}</span>
          </div>
          <div className="d-flex me-1">
            <button
              className="btn btn-sm"
              style={{ minWidth: '36px' }}
              onClick={() => {
                setSelectedNode(undefined);
                hidePreview();
              }}>
              <i className="fas fa-times" style={{ color: '#fff' }} />
            </button>
          </div>
        </div>
        <div
          style={{
            backgroundColor: '#494949',
          }}>
          <Description text={selectedNode.description} legacy={selectedNode.legacy} steps={selectedNode.plugin_steps || []} />
          {!selectedNode.legacy && !readOnly && (
            <div className={`d-flex justify-content-end ${asJsonFormat ? 'mb-3' : ''}`}>
              <button
                className="btn btn-sm toggle-form-buttons mt-3"
                disabled={errors && errors.length > 0}
                onClick={() => toggleJsonFormat(false)}
                style={{ backgroundColor: asJsonFormat ? '#373735' : '#f9b000' }}>
                FORM
              </button>
              <button
                className="btn btn-sm mx-1 toggle-form-buttons mt-3"
                onClick={() => {
                  if (formRef.current)
                    formRef.current.trigger().then((res) => {
                      if (res) toggleJsonFormat(true);
                    });
                }}
                style={{ backgroundColor: asJsonFormat ? '#f9b000' : '#373735' }}>
                RAW JSON
              </button>
            </div>
          )}
          {id === 'Backend' && (
            <BackendSelector
              backends={backends}
              setBackendConfigRef={setBackendConfigRef}
              setUsingExistingBackend={setUsingExistingBackend}
              setRoute={setRoute}
              usingExistingBackend={usingExistingBackend}
              route={route}
            />
          )}
          {!usingExistingBackend || id !== 'Backend' ? (
            <div className="editor-view-form">
              {asJsonFormat ? (
                <>
                  {form.value && (
                    <CodeInput
                      showGutter={false}
                      mode="json"
                      themeStyle={{
                        maxHeight: readOnly ? '300px' : '-1',
                        width: '100%',
                      }}
                      value={stringify(form.value)}
                      onChange={onJsonInputChange}
                    />
                  )}
                  {errors && (
                    <div>
                      {(errors || []).map((error, idx) => (
                        <div
                          style={{
                            borderLeft: '2px solid #D5443F',
                          }}
                          className="mt-3 ps-3"
                          key={`errror${idx}`}>
                          {error}
                        </div>
                      ))}
                    </div>
                  )}
                  {readOnly ? (
                    <div className="d-flex justify-content-end mt-3">
                      <button
                        className="btn btn-sm btn-danger me-1"
                        onClick={() => {
                          setSelectedNode(undefined);
                          hidePreview();
                        }}>
                        Cancel
                      </button>
                      <button
                        className="btn btn-sm btn-save"
                        onClick={() => {
                          hidePreview();
                          addNode(selectedNode);
                        }}>
                        Add to flow
                      </button>
                    </div>
                  ) : (
                    <Actions
                      showUpdateRouteButton={isDirty}
                      valid={() => onValidate(form.value)}
                      selectedNode={selectedNode}
                      onRemove={onRemove}
                    />
                  )}
                </>
              ) : (
                <Form
                  ref={formRef}
                  options={{
                    watch: () => {
                      if (formRef.current) {
                        const formState = formRef.current.methods.formState.isDirty;
                        if (formState !== isDirty)
                          setDirty(formState);
                      }
                    },
                  }}
                  value={unstringify(form.value)}
                  schema={form.schema}
                  flow={form.flow}
                  onSubmit={onValidate}
                  footer={({ valid }) => {
                    return <Actions
                      showUpdateRouteButton={isDirty}
                      valid={valid}
                      selectedNode={selectedNode}
                      onRemove={onRemove}
                    />
                  }}
                />
              )}
            </div>
          ) : (
            <div className="p-3">
              {backendConfigRef && (
                <BackendForm
                  isCreation={false}
                  value={backendConfigRef}
                  style={{ maxWidth: '100%' }}
                  foldable={true}
                />
              )}
              <FeedbackButton
                text="Update the plugin configuration"
                icon={() => <i className="fas fa-paper-plane" />}
                onPress={saveChanges}
              />
            </div>
          )}
        </div>
        {usingExistingBackend && id === 'Backend' && !selectedNode.default && (
          <RemoveComponent onRemove={onRemove} />
        )}
      </div>
    </>
  );
}

const stringify = (item) => (typeof item === 'object' ? JSON.stringify(item, null, 2) : item);
const unstringify = (item) => {
  if (typeof item === 'object') return item;
  else {
    try {
      return JSON.parse(item);
    } catch (_) {
      return item;
    }
  }
};

const Actions = ({ selectedNode, onRemove, valid, showUpdateRouteButton }) => (
  <div className="d-flex mt-4 justify-content-end">
    {!selectedNode.default && <RemoveComponent onRemove={onRemove} />}
    <FeedbackButton
      text="Update route"
      className="ms-2"
      disabled={!showUpdateRouteButton}
      icon={() => <i className="far fa-paper-plane" />}
      onPress={valid}
    />
  </div>
);

const BackendSelector = ({
  setBackendConfigRef,
  setUsingExistingBackend,
  setRoute,
  usingExistingBackend,
  route,
  backends,
}) => (
  <div className="backend-selector">
    <div className={`d-flex ${usingExistingBackend ? 'mb-3' : ''}`}>
      <button
        className="btn btn-sm new-backend-button"
        onClick={() => {
          setBackendConfigRef(undefined);
          setUsingExistingBackend(false);
          setRoute({
            ...route,
            backend_ref: undefined,
          });
        }}
        style={{ backgroundColor: usingExistingBackend ? '#494849' : '#f9b000' }}>
        Create a new backend
      </button>
      <button
        className="btn btn-sm new-backend-button"
        onClick={() => setUsingExistingBackend(true)}
        style={{ backgroundColor: usingExistingBackend ? '#f9b000' : '#494849' }}>
        Select an existing backend
      </button>
    </div>
    {usingExistingBackend && (
      <SelectInput
        id="backend_select"
        value={route.backend_ref}
        placeholder="Select an existing backend"
        label=""
        onChange={(backend_ref) =>
          setRoute({
            ...route,
            backend_ref,
          })
        }
        possibleValues={backends}
        transformer={(item) => ({ label: item.name, value: item.id })}
      />
    )}
  </div>
);

const Description = ({ text, steps, legacy }) => {
  const [showMore, setShowMore] = useState(false);

  const textLength = text ? text.length : 0;
  const overflows = textLength > 300;
  let content = text ? (overflows && !showMore ? text.slice(0, 300) + ' ...' : text) : '...';

  if (content.split('```').length % 2 === 0) {
    content = content + '\n```\n';
  }

  return (
    <>
      <MarkdownInput className="form-description" readOnly={true} preview={true} value={content} />
      <div className="steps" style={{ paddingBottom: 10, paddingLeft: 12 }}>
        active on {steps.map(step => <span className="badge bg-warning text-dark" style={{ marginLeft: 5 }}>{step}</span>)}
      </div>
      {legacy && (
        <div className="steps" style={{ paddingBottom: 10, paddingLeft: 12 }}>
          this plugin is a <span className="badge bg-info text-dark" style={{ marginLeft: 5 }}>legacy plugin</span>
        </div>
      )}
      {overflows && (
        <button
          className="btn btn-sm btn-success me-3 mb-3"
          onClick={() => setShowMore(!showMore)}
          style={{ marginLeft: 'auto', display: 'block' }}>
          {showMore ? 'Show less' : 'Show more description'}
        </button>
      )}
    </>
  );
};

const RemoveComponent = ({ onRemove }) => (
  <button className="btn btn-sm btn-danger" onClick={onRemove}>
    <i className="fas fa-trash me-2"></i>
    Remove this component
  </button>
);
