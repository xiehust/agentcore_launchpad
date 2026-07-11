import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { Server, Globe, Radio, Terminal, Settings, X } from 'lucide-react';

export interface MCPToolNodeData {
  id: string;
  label?: string;
  serverName: string;
  transportType: 'stdio' | 'streamable_http' | 'sse';
  command?: string; // For stdio transport
  args?: string[]; // For stdio transport
  url?: string; // For HTTP/SSE transports
  description?: string;
  timeout?: number;
  headers?: Record<string, string>; // For HTTP/SSE transports
  env?: Record<string, string>; // Environment variables for stdio
}

const getTransportIcon = (transportType: string) => {
  switch (transportType) {
    case 'stdio':
      return <Terminal size={14} />;
    case 'streamable_http':
      return <Globe size={14} />;
    case 'sse':
      return <Radio size={14} />;
    default:
      return <Server size={14} />;
  }
};

const getTransportLabel = (transportType: string) => {
  switch (transportType) {
    case 'stdio':
      return 'Standard I/O';
    case 'streamable_http':
      return 'HTTP';
    case 'sse':
      return 'Server-Sent Events';
    default:
      return 'Unknown';
  }
};

export function MCPToolNode({ data, selected, id }: NodeProps) {
  const { deleteElements } = useReactFlow();
  const nodeData = (data ?? {}) as unknown as MCPToolNodeData;
  const {
    label = 'MCP Server',
    serverName = 'mcp_server',
    transportType = 'stdio',
    command,
    url,
    description,
  } = nodeData;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  const transportIcon = getTransportIcon(transportType);
  const transportLabel = getTransportLabel(transportType);

  return (
    <div className={`studio-node t-gw${selected ? ' sel' : ''}`}>
      <div className="studio-node-head">
        <Server className="studio-node-ic" size={14} />
        <span className="studio-node-title">{label}</span>
        <span className="studio-node-tools">
          <Settings size={12} />
          {selected && (
            <button className="studio-node-del" onClick={handleDelete} title="Delete node">
              <X size={12} />
            </button>
          )}
        </span>
      </div>

      <div className="studio-node-body">
        <div className="studio-node-row" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="studio-node-ic" style={{ display: 'inline-flex' }}>{transportIcon}</span>
          <span style={{ color: 'var(--ink)' }}>{serverName}</span>
        </div>
        <div className="studio-node-row"><span className="studio-node-k">Transport:</span> {transportLabel}</div>
        {transportType === 'stdio' && command && (
          <div className="studio-node-row"><span className="studio-node-k">Command:</span> {command}</div>
        )}
        {(transportType === 'streamable_http' || transportType === 'sse') && url && (
          <div className="studio-node-row"><span className="studio-node-k">URL:</span> {url}</div>
        )}
        {description && <div className="studio-node-desc">{description}</div>}
      </div>

      {/* Output Handle - connects to agent tools input */}
      <Handle type="source" position={Position.Right} id="mcp-tools" className="h-tool" title="MCP tools" />
    </div>
  );
}
