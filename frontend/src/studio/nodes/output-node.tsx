import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Settings, X } from 'lucide-react';

interface OutputNodeData {
  label?: string;
  outputType?: 'response' | 'file' | 'data';
  format?: 'text' | 'json' | 'markdown' | 'csv';
  destination?: string;
}

export function OutputNode({ data, selected, id }: NodeProps) {
  const { t } = useTranslation();
  const { deleteElements } = useReactFlow();
  const nodeData = (data ?? {}) as OutputNodeData;
  const {
    label = 'Output',
    outputType = 'response',
    format = 'text',
    destination = 'Display',
  } = nodeData;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div className={`studio-node t-muted${selected ? ' sel' : ''}`} style={{ minWidth: 180 }}>
      <div className="studio-node-head">
        <ArrowLeft className="studio-node-ic" size={14} />
        <span className="studio-node-title">{label}</span>
        <span className="studio-node-tools">
          <Settings size={12} />
          {selected && (
            <button className="studio-node-del" onClick={handleDelete} title={t('studio.nodeCard.deleteTitle')}>
              <X size={12} />
            </button>
          )}
        </span>
      </div>

      <div className="studio-node-body">
        <div className="studio-node-row"><span className="studio-node-k">{t('studio.nodeCard.type')}</span> {outputType}</div>
        <div className="studio-node-row"><span className="studio-node-k">{t('studio.nodeCard.format')}</span> {format}</div>
        <div className="studio-node-row"><span className="studio-node-k">{t('studio.nodeCard.to')}</span> {destination}</div>
      </div>

      {/* Input Handle */}
      <Handle type="target" position={Position.Left} id="input" className="h-out" title="Input" />
    </div>
  );
}
