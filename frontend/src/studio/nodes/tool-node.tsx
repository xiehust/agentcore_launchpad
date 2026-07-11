import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Wrench, Package, Code, X } from 'lucide-react';

interface ToolNodeData {
  label?: string;
  toolType?: 'built-in' | 'custom';
  toolName?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export function ToolNode({ data, selected, id }: NodeProps) {
  const { t } = useTranslation();
  const { deleteElements } = useReactFlow();
  const nodeData = (data ?? {}) as ToolNodeData;
  const {
    label = 'Tool',
    toolType = 'built-in',
    toolName = 'calculator',
    description = 'Calculator functionality',
  } = nodeData;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  const isBuiltIn = toolType === 'built-in';
  const KindIcon = isBuiltIn ? Package : Code;

  return (
    <div className={`studio-node ${isBuiltIn ? 't-tool' : 't-aqua'}${selected ? ' sel' : ''}`} style={{ minWidth: 180 }}>
      <div className="studio-node-head">
        <Wrench className="studio-node-ic" size={14} />
        <span className="studio-node-title">{label}</span>
        <span className="studio-node-tools">
          <KindIcon size={12} />
          {selected && (
            <button className="studio-node-del" onClick={handleDelete} title={t('studio.nodeCard.deleteTitle')}>
              <X size={12} />
            </button>
          )}
        </span>
      </div>

      <div className="studio-node-body">
        <div className="studio-node-row"><span className="studio-node-k">{t('studio.nodeCard.type')}</span> {toolType}</div>
        <div className="studio-node-row"><span className="studio-node-k">{t('studio.nodeCard.tool')}</span> {toolName}</div>
        {description && <div className="studio-node-desc">{description}</div>}
      </div>

      {/* Output Handle */}
      <Handle type="source" position={Position.Right} id="tool-output" className="h-tool" title="Tool output" />
    </div>
  );
}
