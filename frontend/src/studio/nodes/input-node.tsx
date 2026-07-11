import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { ArrowRight, MessageCircle, X } from 'lucide-react';

interface InputNodeData {
  label?: string;
}

export function InputNode({ data, selected, id }: NodeProps) {
  const { deleteElements } = useReactFlow();
  const nodeData = (data ?? {}) as InputNodeData;
  const { label = 'Input' } = nodeData;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div className={`studio-node t-muted${selected ? ' sel' : ''}`}>
      <div className="studio-node-head">
        <ArrowRight className="studio-node-ic" size={14} />
        <span className="studio-node-title">{label}</span>
        <span className="studio-node-tools">
          <MessageCircle size={12} />
          {selected && (
            <button className="studio-node-del" onClick={handleDelete} title="Delete node">
              <X size={12} />
            </button>
          )}
        </span>
      </div>

      <div className="studio-node-body">
        <div className="studio-node-desc">Connects user input to agents</div>
      </div>

      {/* Output Handle */}
      <Handle type="source" position={Position.Right} id="output" className="h-in" title="User input" />
    </div>
  );
}
