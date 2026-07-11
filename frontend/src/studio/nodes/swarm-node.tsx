import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { Users, Settings, X } from 'lucide-react';

interface SwarmNodeData {
  label?: string;
  entryPointAgentId?: string; // ID of the agent node that should be the entry point
  maxHandoffs?: number;
  maxIterations?: number;
  executionTimeout?: number; // in seconds
  nodeTimeout?: number; // in seconds
  repetitiveHandoffDetectionWindow?: number;
  repetitiveHandoffMinUniqueAgents?: number;
  streaming?: boolean;
}

export function SwarmNode({ data, selected, id }: NodeProps) {
  const { deleteElements } = useReactFlow();
  const nodeData = (data ?? {}) as SwarmNodeData;
  const {
    label = 'Swarm',
    maxHandoffs = 20,
    maxIterations = 20,
    executionTimeout = 900, // 15 minutes
    nodeTimeout = 300, // 5 minutes
  } = nodeData;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div className={`studio-node t-blue${selected ? ' sel' : ''}`} style={{ minWidth: 240 }}>
      <div className="studio-node-head">
        <Users className="studio-node-ic" size={14} />
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
        <div className="studio-node-row"><span className="studio-node-k">Max Handoffs:</span> {maxHandoffs}</div>
        <div className="studio-node-row"><span className="studio-node-k">Max Iterations:</span> {maxIterations}</div>
        <div className="studio-node-row"><span className="studio-node-k">Execution Timeout:</span> {executionTimeout}s</div>
        <div className="studio-node-row"><span className="studio-node-k">Node Timeout:</span> {nodeTimeout}s</div>
      </div>

      {/* Input Handle */}
      <Handle type="target" position={Position.Top} id="user-input" className="h-in" title="Input: user prompt" />

      {/* Agents Handle (to connect to agent nodes that will be part of the swarm) */}
      <Handle type="source" position={Position.Right} id="sub-agents" className="h-sub" title="Swarm agents" />

      {/* Output Handle */}
      <Handle type="source" position={Position.Bottom} id="output" className="h-out" title="Output" />
    </div>
  );
}
