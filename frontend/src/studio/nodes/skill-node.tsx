import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Sparkles, X } from 'lucide-react';

interface SkillNodeData {
  label?: string;
  skillName?: string;
  description?: string;
}

export function SkillNode({ data, selected, id }: NodeProps) {
  const { t } = useTranslation();
  const { deleteElements } = useReactFlow();
  const nodeData = (data ?? {}) as SkillNodeData;
  const { label = 'Skill', skillName = '', description = '' } = nodeData;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  return (
    <div className={`studio-node t-mem${selected ? ' sel' : ''}`} style={{ minWidth: 180 }}>
      <div className="studio-node-head">
        <Sparkles className="studio-node-ic" size={14} />
        <span className="studio-node-title">{label}</span>
        <span className="studio-node-tools">
          {selected && (
            <button className="studio-node-del" onClick={handleDelete} title={t('studio.nodeCard.deleteTitle')}>
              <X size={12} />
            </button>
          )}
        </span>
      </div>

      <div className="studio-node-body">
        <div className="studio-node-row">
          <span className="studio-node-k">{t('studio.nodeCard.skill')}</span>{' '}
          {skillName || t('studio.nodeCard.skillUnset')}
        </div>
        {description && <div className="studio-node-desc">{description}</div>}
        {!skillName && <div className="studio-warn">{t('studio.nodeCard.skillSelectHint')}</div>}
      </div>

      {/* Output Handle — attaches to an agent's tools handle */}
      <Handle type="source" position={Position.Right} id="skill-output" className="h-skill" title="Skill output" />
    </div>
  );
}
