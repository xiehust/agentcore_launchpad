import { type Node, type Edge } from '@xyflow/react';
import { Settings, X } from 'lucide-react';

// Union of every field the node data objects can carry across all node types.
// Keeping them optional lets each render function read only what it needs while
// staying byte-faithful to the upstream data-key contract the generators read.
interface StudioNodeData {
  label?: string;
  // agent / orchestrator
  modelProvider?: string;
  modelId?: string;
  modelName?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
  apiKey?: string;
  baseUrl?: string;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
  coordinationPrompt?: string;
  // tool
  toolType?: string;
  toolName?: string;
  description?: string;
  // mcp-tool
  serverName?: string;
  transportType?: string;
  command?: string;
  args?: string[];
  argsText?: string;
  url?: string;
  headers?: Record<string, string>;
  headersText?: string;
  env?: Record<string, string>;
  envText?: string;
  timeout?: number;
  // custom-tool
  pythonCode?: string;
  // swarm
  maxHandoffs?: number;
  maxIterations?: number;
  executionTimeout?: number;
  nodeTimeout?: number;
  repetitiveHandoffDetectionWindow?: number;
  repetitiveHandoffMinUniqueAgents?: number;
  // graph-builder
  enableDebugLogs?: boolean;
}

interface PropertyPanelProps {
  selectedNode: Node | null;
  onClose: () => void;
  onUpdateNode: (nodeId: string, data: Record<string, unknown>) => void;
  edges?: Edge[];
  nodes?: Node[];
  className?: string;
}

export function PropertyPanel({
  selectedNode,
  onClose,
  onUpdateNode,
  edges = [],
  nodes = [],
  className = '',
}: PropertyPanelProps) {
  if (!selectedNode) {
    return null;
  }

  const node = selectedNode;

  // Check if the selected node has an output node connected
  const hasConnectedOutputNode = () => {
    if (node.type !== 'agent' && node.type !== 'orchestrator-agent') {
      return true; // For non-agent nodes, always allow streaming
    }

    // Find all edges where this node is the source from its output handle
    const outgoingEdges = edges.filter(
      (edge) => edge.source === node.id && edge.sourceHandle === 'output',
    );

    // For each outgoing edge, check if the target node is an output node
    return outgoingEdges.some((edge) => {
      const targetNode = nodes.find((n) => n.id === edge.target);
      return targetNode && targetNode.type === 'output';
    });
  };

  const handleInputChange = (field: string, value: unknown) => {
    try {
      onUpdateNode(node.id, {
        ...node.data,
        [field]: value,
      });
    } catch (error) {
      console.error('Failed to update node property:', error);
    }
  };

  const bedrockModels = [
    {
      model_id: 'global.anthropic.claude-sonnet-4-6',
      model_name: 'Claude Sonnet 4.6 (global, launchpad default)',
    },
    {
      model_id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      model_name: 'Claude 4.5 Haiku (global)',
    },
    { model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', model_name: 'Claude 4.5 Haiku (US)' },
    { model_id: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', model_name: 'Claude 4.5 Haiku (EU)' },
    {
      model_id: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      model_name: 'Claude 4.5 Sonnet (global)',
    },
    {
      model_id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      model_name: 'Claude 4.5 Sonnet (US)',
    },
    {
      model_id: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
      model_name: 'Claude 4.5 Sonnet (EU)',
    },
    {
      model_id: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
      model_name: 'Claude 4 Sonnet (global)',
    },
    { model_id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', model_name: 'Claude 4 Sonnet (US)' },
    { model_id: 'eu.anthropic.claude-sonnet-4-20250514-v1:0', model_name: 'Claude 4 Sonnet (EU)' },
    {
      model_id: 'apac.anthropic.claude-sonnet-4-20250514-v1:0',
      model_name: 'Claude 4 Sonnet (APAC)',
    },
    {
      model_id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      model_name: 'Claude 3.7 Sonnet (US)',
    },
    {
      model_id: 'eu.anthropic.claude-3-7-sonnet-20250219-v1:0',
      model_name: 'Claude 3.7 Sonnet (EU)',
    },
    {
      model_id: 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0',
      model_name: 'Claude 3.7 Sonnet (APAC)',
    },
    { model_id: 'openai.gpt-oss-120b-1:0', model_name: 'GPT-OSS-120B' },
    { model_id: 'qwen.qwen3-235b-a22b-2507-v1:0', model_name: 'Qwen3 235B A22B 2507' },
    { model_id: 'qwen.qwen3-32b-v1:0', model_name: 'Qwen3 32B (dense)' },
    { model_id: 'qwen.qwen3-coder-480b-a35b-v1:0', model_name: 'Qwen3 Coder 480B A35B Instruct' },
    { model_id: 'deepseek.v3-v1:0', model_name: 'DeepSeek-V3.1' },
    { model_id: 'us.amazon.nova-premier-v1:0', model_name: 'Amazon Nova Premier v1' },
    { model_id: 'us.amazon.nova-pro-v1:0', model_name: 'Amazon Nova Pro v1' },
  ];

  // Shared model block. `allowAnthropic` mirrors upstream: the orchestrator's
  // provider dropdown offered Anthropic (agent's did not). There is no Anthropic
  // codegen branch — it falls through to Bedrock — but the option value is kept
  // to stay faithful to the upstream data contract.
  const renderModelFields = (data: StudioNodeData, allowAnthropic = false) => (
    <>
      <div className="field">
        <label>Model provider</label>
        <select
          className="input"
          value={data.modelProvider || 'AWS Bedrock'}
          onChange={(e) => {
            if (e.target.value === 'AWS Bedrock') {
              onUpdateNode(node.id, {
                ...node.data,
                modelProvider: e.target.value,
                modelId: bedrockModels[0].model_id,
                modelName: bedrockModels[0].model_name,
              });
            } else {
              onUpdateNode(node.id, {
                ...node.data,
                modelProvider: e.target.value,
                modelId: '',
                modelName: '',
              });
            }
          }}
        >
          <option value="AWS Bedrock">AWS Bedrock</option>
          <option value="OpenAI">OpenAI</option>
          {allowAnthropic && <option value="Anthropic">Anthropic</option>}
        </select>
      </div>

      <div className="field">
        <label>Model</label>
        {data.modelProvider === 'AWS Bedrock' || !data.modelProvider ? (
          <select
            className="input"
            value={data.modelId || bedrockModels[0].model_id}
            onChange={(e) => {
              const selectedModel = bedrockModels.find((m) => m.model_id === e.target.value);
              if (selectedModel) {
                onUpdateNode(node.id, {
                  ...node.data,
                  modelId: selectedModel.model_id,
                  modelName: selectedModel.model_name,
                });
              }
            }}
          >
            {bedrockModels.map((model) => (
              <option key={model.model_id} value={model.model_id}>
                {model.model_name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            type="text"
            value={data.modelName || ''}
            onChange={(e) => handleInputChange('modelName', e.target.value)}
            placeholder="Enter model name (e.g., gpt-4o, gpt-3.5-turbo)"
          />
        )}
      </div>

      {data.modelProvider === 'OpenAI' && (
        <>
          <div className="field">
            <label>API key</label>
            <input
              className="input"
              type="password"
              value={data.apiKey || ''}
              onChange={(e) => handleInputChange('apiKey', e.target.value)}
              placeholder="Enter your OpenAI API key"
            />
            <div className="studio-prop-hint">
              API key will be stored securely as OPENAI_API_KEY environment variable
            </div>
          </div>

          <div className="field">
            <label>Base URL (optional)</label>
            <input
              className="input"
              type="url"
              value={data.baseUrl || ''}
              onChange={(e) => handleInputChange('baseUrl', e.target.value)}
              placeholder="https://api.openai.com/v1 (default)"
            />
            <div className="studio-prop-hint">
              Leave empty to use the default OpenAI API endpoint
            </div>
          </div>
        </>
      )}
    </>
  );

  const renderTemperatureField = (data: StudioNodeData) => {
    const isBedrockThinking =
      (data.modelProvider === 'AWS Bedrock' || !data.modelProvider) && !!data.thinkingEnabled;
    const shown = isBedrockThinking ? 1 : data.temperature || 0.7;
    return (
      <div className="field">
        <label>Temperature: {shown}</label>
        <input
          className="studio-range"
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={shown}
          disabled={isBedrockThinking}
          onChange={(e) => {
            if (!isBedrockThinking) {
              handleInputChange('temperature', parseFloat(e.target.value));
            }
          }}
        />
        {isBedrockThinking && (
          <div className="studio-warn">
            Temperature is locked to 1.0 when thinking is enabled (Bedrock only)
          </div>
        )}
      </div>
    );
  };

  const renderThinkingSection = (data: StudioNodeData) => (
    <div className="studio-prop-sect">
      <div className="kicker" style={{ marginBottom: 10 }}>
        Advanced settings
      </div>
      <div className="field">
        <label className="studio-check">
          <input
            type="checkbox"
            checked={data.thinkingEnabled || false}
            onChange={(e) => handleInputChange('thinkingEnabled', e.target.checked)}
          />
          <span>Enable thinking</span>
        </label>
        <div className="studio-prop-hint">
          Enable extended thinking for more complex reasoning
        </div>
      </div>

      {data.thinkingEnabled &&
        (data.modelProvider === 'AWS Bedrock' || !data.modelProvider ? (
          <div className="field">
            <label>Thinking budget tokens: {data.thinkingBudgetTokens || 2048}</label>
            <input
              className="studio-range"
              type="range"
              min="1024"
              max="8192"
              step="512"
              value={data.thinkingBudgetTokens || 2048}
              onChange={(e) => handleInputChange('thinkingBudgetTokens', parseInt(e.target.value))}
            />
            <div className="studio-range-ends">
              <span>1,024</span>
              <span>8,192</span>
            </div>
          </div>
        ) : (
          <div className="field">
            <label>Reasoning effort</label>
            <select
              className="input"
              value={data.reasoningEffort || 'medium'}
              onChange={(e) => handleInputChange('reasoningEffort', e.target.value)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        ))}
    </div>
  );

  const renderStreamingField = (data: StudioNodeData) => (
    <div className="field">
      <label className="studio-check">
        <input
          type="checkbox"
          checked={data.streaming || false}
          disabled={!hasConnectedOutputNode()}
          onChange={(e) => handleInputChange('streaming', e.target.checked)}
        />
        <span>Enable streaming</span>
      </label>
      <div className="studio-prop-hint">
        {hasConnectedOutputNode()
          ? 'Stream responses in real-time for better user experience'
          : 'Connect an Output node to enable streaming mode'}
      </div>
    </div>
  );

  const renderAgentProperties = (data: StudioNodeData) => (
    <div>
      <div className="field">
        <label>Agent name</label>
        <input
          className="input"
          type="text"
          value={data.label || ''}
          onChange={(e) => handleInputChange('label', e.target.value)}
          placeholder="Agent Name"
        />
      </div>

      {renderModelFields(data)}

      <div className="field">
        <label>System prompt</label>
        <textarea
          className="input mono"
          style={{ minHeight: 88, resize: 'vertical' }}
          value={data.systemPrompt || ''}
          onChange={(e) => handleInputChange('systemPrompt', e.target.value)}
          placeholder="You are a helpful AI assistant..."
          rows={4}
        />
      </div>

      {renderTemperatureField(data)}

      <div className="field">
        <label>Max tokens</label>
        <input
          className="input"
          type="number"
          value={data.maxTokens || 10000}
          onChange={(e) => handleInputChange('maxTokens', parseInt(e.target.value))}
          min="1"
          max="100000"
        />
      </div>

      {renderStreamingField(data)}
      {renderThinkingSection(data)}
    </div>
  );

  const renderOrchestratorAgentProperties = (data: StudioNodeData) => (
    <div>
      <div className="field">
        <label>Orchestrator name</label>
        <input
          className="input"
          type="text"
          value={data.label || ''}
          onChange={(e) => handleInputChange('label', e.target.value)}
          placeholder="Orchestrator Agent"
        />
      </div>

      {renderModelFields(data, true)}

      <div className="field">
        <label>System prompt</label>
        <textarea
          className="input mono"
          style={{ minHeight: 88, resize: 'vertical' }}
          value={data.systemPrompt || ''}
          onChange={(e) => handleInputChange('systemPrompt', e.target.value)}
          placeholder="You are an orchestrator agent that coordinates multiple specialized agents..."
          rows={4}
        />
      </div>

      <div className="studio-prop-sect">
        <div className="kicker" style={{ marginBottom: 10 }}>
          Orchestration settings
        </div>
        <div className="field">
          <label>Coordination prompt</label>
          <textarea
            className="input mono"
            style={{ minHeight: 66, resize: 'vertical' }}
            value={data.coordinationPrompt || ''}
            onChange={(e) => handleInputChange('coordinationPrompt', e.target.value)}
            placeholder="Instructions for how to coordinate and aggregate results from sub-agents..."
            rows={3}
          />
        </div>
      </div>

      {renderTemperatureField(data)}

      <div className="field">
        <label>Max tokens</label>
        <input
          className="input"
          type="number"
          value={data.maxTokens || 10000}
          onChange={(e) => handleInputChange('maxTokens', parseInt(e.target.value))}
          min="100"
          max="100000"
        />
      </div>

      {renderStreamingField(data)}
      {renderThinkingSection(data)}
    </div>
  );

  const renderToolProperties = (data: StudioNodeData) => (
    <div>
      <div className="field">
        <label>Tool name</label>
        <input
          className="input"
          type="text"
          value={data.label || ''}
          onChange={(e) => handleInputChange('label', e.target.value)}
          placeholder="Tool Name"
        />
      </div>

      <div className="field">
        <label>Tool type</label>
        <select
          className="input"
          value={data.toolType || 'built-in'}
          onChange={(e) => handleInputChange('toolType', e.target.value)}
        >
          <option value="built-in">Built-in</option>
        </select>
      </div>

      <div className="field">
        <label>Tool name / function</label>
        {data.toolType === 'built-in' || !data.toolType ? (
          <select
            className="input"
            value={data.toolName || 'calculator'}
            onChange={(e) => handleInputChange('toolName', e.target.value)}
          >
            <option value="calculator">Calculator</option>
            <option value="file_read">File Reader</option>
            <option value="file_write">File Write</option>
            <option value="shell">Shell Command</option>
            <option value="current_time">Current Time</option>
            <option value="http_request">Http Request</option>
            <option value="editor">Editor</option>
            <option value="retrieve">Retrieve (KB)</option>
            <option value="mem0_memory">mem0_memory</option>
          </select>
        ) : (
          <input
            className="input"
            type="text"
            value={data.toolName || ''}
            onChange={(e) => handleInputChange('toolName', e.target.value)}
            placeholder="custom_function_name"
          />
        )}
      </div>

      <div className="field">
        <label>Description</label>
        <textarea
          className="input"
          style={{ resize: 'vertical' }}
          value={data.description || ''}
          onChange={(e) => handleInputChange('description', e.target.value)}
          placeholder="Tool description..."
          rows={3}
        />
      </div>
    </div>
  );

  const renderInputProperties = () => (
    <div className="studio-prop-empty">
      Input node — connects user input to agents.
      <div style={{ marginTop: 8 }}>No configuration required.</div>
    </div>
  );

  const renderMCPToolProperties = (data: StudioNodeData) => (
    <div>
      <div className="field">
        <label>Server name</label>
        <input
          className="input"
          type="text"
          value={data.serverName || ''}
          onChange={(e) => handleInputChange('serverName', e.target.value)}
          placeholder="MCP Server Name"
        />
      </div>

      <div className="field">
        <label>Transport type</label>
        <select
          className="input"
          value={data.transportType || 'stdio'}
          onChange={(e) => handleInputChange('transportType', e.target.value)}
        >
          <option value="stdio">Standard I/O (stdio)</option>
          <option value="streamable_http">Streamable HTTP</option>
          <option value="sse">Server-Sent Events (SSE)</option>
        </select>
      </div>

      {data.transportType === 'stdio' && (
        <>
          <div className="field">
            <label>Command</label>
            <input
              className="input"
              type="text"
              value={data.command || ''}
              onChange={(e) => handleInputChange('command', e.target.value)}
              placeholder="uvx"
            />
          </div>

          <div className="field">
            <label>Arguments (one per line)</label>
            <textarea
              className="input mono"
              style={{ resize: 'vertical' }}
              value={data.argsText !== undefined ? data.argsText : data.args ? data.args.join('\n') : ''}
              onChange={(e) => {
                const argsText = e.target.value;
                const args = argsText.split('\n').filter((arg) => arg.trim());
                onUpdateNode(node.id, {
                  ...node.data,
                  argsText: argsText,
                  args: args,
                });
              }}
              placeholder="server-name@latest"
              rows={3}
            />
            <div className="studio-prop-hint">Enter each argument on a separate line</div>
          </div>

          <div className="field">
            <label>Environment variables (JSON format)</label>
            <textarea
              className="input mono"
              style={{ resize: 'vertical' }}
              value={
                data.envText ||
                (data.env && Object.keys(data.env).length > 0
                  ? JSON.stringify(data.env, null, 2)
                  : '')
              }
              onChange={(e) => {
                const envText = e.target.value.trim();
                try {
                  const env = envText ? JSON.parse(envText) : {};
                  handleInputChange('envText', envText);
                  handleInputChange('env', env);
                } catch {
                  // Keep the text even if JSON is invalid for user to continue editing
                  handleInputChange('envText', envText);
                }
              }}
              placeholder={'{\n  "PATH": "/usr/local/bin",\n  "API_KEY": "your-key"\n}'}
              rows={4}
            />
            <div className="studio-prop-hint">
              Optional environment variables for the MCP server process (valid JSON required)
            </div>
          </div>
        </>
      )}

      {(data.transportType === 'streamable_http' || data.transportType === 'sse') && (
        <>
          <div className="field">
            <label>Server URL</label>
            <input
              className="input"
              type="url"
              value={data.url || ''}
              onChange={(e) => handleInputChange('url', e.target.value)}
              placeholder="http://localhost:8000/mcp"
            />
          </div>

          <div className="field">
            <label>Headers (JSON format)</label>
            <textarea
              className="input mono"
              style={{ resize: 'vertical' }}
              value={data.headersText || ''}
              onChange={(e) => {
                const headersText = e.target.value;
                try {
                  const headers = headersText ? JSON.parse(headersText) : {};
                  handleInputChange('headersText', headersText);
                  handleInputChange('headers', headers);
                } catch {
                  handleInputChange('headersText', headersText);
                }
              }}
              placeholder='{"Authorization": "Bearer token"}'
              rows={3}
            />
          </div>
        </>
      )}

      <div className="field">
        <label>Timeout (seconds)</label>
        <input
          className="input"
          type="number"
          value={data.timeout || 30}
          onChange={(e) => handleInputChange('timeout', parseInt(e.target.value))}
          min="1"
          max="300"
        />
      </div>

      <div className="field">
        <label>Description</label>
        <textarea
          className="input"
          style={{ resize: 'vertical' }}
          value={data.description || ''}
          onChange={(e) => handleInputChange('description', e.target.value)}
          placeholder="Description of the MCP server..."
          rows={3}
        />
      </div>
    </div>
  );

  const renderCustomToolProperties = (data: StudioNodeData) => (
    <div>
      <div className="field">
        <label>Tool name</label>
        <input
          className="input"
          type="text"
          value={data.label || ''}
          onChange={(e) => handleInputChange('label', e.target.value)}
          placeholder="My Custom Tool"
        />
      </div>

      <div className="field">
        <label>Python function</label>
        <textarea
          className="input mono"
          style={{ minHeight: 220, resize: 'vertical' }}
          value={data.pythonCode || ''}
          onChange={(e) => handleInputChange('pythonCode', e.target.value)}
          placeholder={
            'def word_counter(text: str) -> str:\n    """Count words in the provided text"""\n    word_count = len(text.split())\n    return f"Word count: {word_count}"'
          }
          rows={12}
        />
        <div className="studio-prop-hint">
          Complete Python function with type hints and docstring. The function will be automatically
          decorated with @tool.
        </div>
      </div>
    </div>
  );

  const renderGraphBuilderProperties = (data: StudioNodeData) => (
    <div>
      <div className="field">
        <label>Graph name</label>
        <input
          className="input"
          type="text"
          value={data.label || ''}
          onChange={(e) => handleInputChange('label', e.target.value)}
          placeholder="Graph"
        />
        <div className="studio-prop-hint">Name for this graph workflow</div>
      </div>

      <div className="studio-prop-sect">
        <div className="kicker" style={{ marginBottom: 8 }}>
          Entry points
        </div>
        <div className="studio-prop-hint">
          Connect the sub-agents handle (right side) to agent nodes to define entry points. Entry
          point agents receive the original user input.
        </div>
      </div>

      <div className="studio-prop-sect">
        <div className="kicker" style={{ marginBottom: 8 }}>
          Agent dependencies
        </div>
        <div className="studio-prop-hint">
          Connect agent output (bottom) to another agent's input (top) to define execution
          dependencies. Example: Agent A → Agent B means B depends on A's output.
        </div>
      </div>

      <div className="field">
        <label className="studio-check">
          <input
            type="checkbox"
            checked={data.enableDebugLogs || false}
            onChange={(e) => handleInputChange('enableDebugLogs', e.target.checked)}
          />
          <span>Enable debug logs</span>
        </label>
        <div className="studio-prop-hint">Enable debug logging for graph execution</div>
      </div>

      <div className="field">
        <label>Execution timeout (seconds)</label>
        <input
          className="input"
          type="number"
          value={data.executionTimeout || ''}
          onChange={(e) =>
            handleInputChange('executionTimeout', e.target.value ? parseInt(e.target.value) : undefined)
          }
          placeholder="Optional"
          min="1"
        />
        <div className="studio-prop-hint">Leave empty for no timeout</div>
      </div>
    </div>
  );

  const renderSwarmProperties = (data: StudioNodeData) => (
    <div>
      <div className="field">
        <label>Swarm name</label>
        <input
          className="input"
          type="text"
          value={data.label || ''}
          onChange={(e) => handleInputChange('label', e.target.value)}
          placeholder="Swarm Name"
        />
      </div>

      <div className="studio-prop-sect">
        <div className="kicker" style={{ marginBottom: 10 }}>
          Execution settings
        </div>

        <div className="field">
          <label>Max handoffs</label>
          <input
            className="input"
            type="number"
            value={data.maxHandoffs || 20}
            onChange={(e) => handleInputChange('maxHandoffs', parseInt(e.target.value))}
            min="1"
            max="100"
          />
          <div className="studio-prop-hint">
            Maximum number of agent handoffs allowed during execution
          </div>
        </div>

        <div className="field">
          <label>Max iterations</label>
          <input
            className="input"
            type="number"
            value={data.maxIterations || 20}
            onChange={(e) => handleInputChange('maxIterations', parseInt(e.target.value))}
            min="1"
            max="100"
          />
          <div className="studio-prop-hint">Maximum total iterations across all agents</div>
        </div>

        <div className="field">
          <label>Execution timeout (seconds)</label>
          <input
            className="input"
            type="number"
            value={data.executionTimeout || 900}
            onChange={(e) => handleInputChange('executionTimeout', parseInt(e.target.value))}
            min="10"
            max="3600"
          />
          <div className="studio-prop-hint">
            Total execution timeout in seconds (default: 900 = 15 minutes)
          </div>
        </div>

        <div className="field">
          <label>Node timeout (seconds)</label>
          <input
            className="input"
            type="number"
            value={data.nodeTimeout || 300}
            onChange={(e) => handleInputChange('nodeTimeout', parseInt(e.target.value))}
            min="5"
            max="1800"
          />
          <div className="studio-prop-hint">
            Individual agent timeout in seconds (default: 300 = 5 minutes)
          </div>
        </div>

        <div className="field">
          <label>Repetitive handoff detection window</label>
          <input
            className="input"
            type="number"
            value={data.repetitiveHandoffDetectionWindow || 0}
            onChange={(e) =>
              handleInputChange('repetitiveHandoffDetectionWindow', parseInt(e.target.value))
            }
            min="0"
            max="20"
          />
          <div className="studio-prop-hint">
            Number of recent nodes to check for ping-pong behavior (0 = disabled)
          </div>
        </div>

        <div className="field">
          <label>Min unique agents for detection</label>
          <input
            className="input"
            type="number"
            value={data.repetitiveHandoffMinUniqueAgents || 0}
            onChange={(e) =>
              handleInputChange('repetitiveHandoffMinUniqueAgents', parseInt(e.target.value))
            }
            min="0"
            max="10"
          />
          <div className="studio-prop-hint">
            Minimum unique nodes required in recent sequence (0 = disabled)
          </div>
        </div>
      </div>
    </div>
  );

  const renderProperties = () => {
    const data = node.data as StudioNodeData;
    switch (node.type) {
      case 'agent':
        return renderAgentProperties(data);
      case 'orchestrator-agent':
        return renderOrchestratorAgentProperties(data);
      case 'swarm':
        return renderSwarmProperties(data);
      case 'graph-builder':
        return renderGraphBuilderProperties(data);
      case 'tool':
        return renderToolProperties(data);
      case 'mcp-tool':
        return renderMCPToolProperties(data);
      case 'input':
        return renderInputProperties();
      case 'custom-tool':
        return renderCustomToolProperties(data);
      default:
        return (
          <div className="studio-prop-empty">No properties available for this node type.</div>
        );
    }
  };

  return (
    <div className={`studio-prop ${className}`}>
      <div className="studio-prop-head">
        <Settings size={14} />
        <h3>Properties</h3>
        <button className="studio-prop-x" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="studio-prop-body">
        <div className="studio-prop-type">
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.18em',
              color: 'var(--ink-3)',
              marginBottom: 6,
            }}
          >
            NODE TYPE
          </label>
          <div className="studio-prop-typev">{node.type}</div>
        </div>

        {renderProperties()}
      </div>
    </div>
  );
}
