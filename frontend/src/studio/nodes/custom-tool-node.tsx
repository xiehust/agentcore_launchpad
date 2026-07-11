import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Code, Settings, X } from 'lucide-react';

interface CustomToolNodeData {
  label?: string;
  functionName?: string;
  description?: string;
  parameters?: string[];
  pythonCode?: string;
}

export function CustomToolNode({ data, selected, id }: NodeProps) {
  const { t } = useTranslation();
  const { deleteElements } = useReactFlow();
  const nodeData = (data ?? {}) as CustomToolNodeData;
  const {
    label = 'Custom Tool',
    functionName = 'my_custom_tool',
    description = 'Custom Python function for specific tasks',
    parameters = ['input_text', 'options'],
    pythonCode = '',
  } = nodeData;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div className={`studio-node t-aqua${selected ? ' sel' : ''}`} style={{ minWidth: 220 }}>
      <div className="studio-node-head">
        <Code className="studio-node-ic" size={14} />
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
        <div className="studio-node-row"><span className="studio-node-k">{t('studio.nodeCard.function')}</span> {functionName}</div>

        {parameters && parameters.length > 0 && (
          <div>
            <div className="studio-node-row"><span className="studio-node-k">{t('studio.nodeCard.parameters')}</span></div>
            <div className="studio-node-params">
              {parameters.map((param) => (
                <span key={param} className="studio-node-param">{param}</span>
              ))}
            </div>
          </div>
        )}

        {description && <div className="studio-node-desc">{description}</div>}

        {pythonCode && (
          <pre className="code studio-codeprev">
            {pythonCode.length > 200 ? pythonCode.substring(0, 200) + '...' : pythonCode}
          </pre>
        )}
      </div>

      {/* Input Handle */}
      <Handle type="target" position={Position.Left} id="config" className="h-cfg" title="Config" />

      {/* Output Handle */}
      <Handle type="source" position={Position.Right} id="tool-output" className="h-tool" title="Tool output" />
    </div>
  );
}
