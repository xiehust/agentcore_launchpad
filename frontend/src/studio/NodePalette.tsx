import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Wrench,
  ArrowRight,
  ArrowLeft,
  Code,
  Server,
  Crown,
  Users,
  type LucideIcon,
} from 'lucide-react';

interface NodeTypeItem {
  type: string;
  nameKey: string;
  descKey: string;
  icon: LucideIcon;
  category: string;
}

// nameKey/descKey point at studio.nodes.* so both locales localize the palette;
// `type` stays the generator's contract string and is never translated.
const nodeTypes: NodeTypeItem[] = [
  {
    type: 'agent',
    nameKey: 'studio.nodes.agent.name',
    descKey: 'studio.nodes.agent.desc',
    icon: Bot,
    category: 'Core',
  },
  {
    type: 'orchestrator-agent',
    nameKey: 'studio.nodes.orchestrator.name',
    descKey: 'studio.nodes.orchestrator.desc',
    icon: Crown,
    category: 'Advanced',
  },
  {
    type: 'swarm',
    nameKey: 'studio.nodes.swarm.name',
    descKey: 'studio.nodes.swarm.desc',
    icon: Users,
    category: 'Advanced',
  },
  {
    type: 'tool',
    nameKey: 'studio.nodes.tool.name',
    descKey: 'studio.nodes.tool.desc',
    icon: Wrench,
    category: 'Core',
  },
  {
    type: 'mcp-tool',
    nameKey: 'studio.nodes.mcp.name',
    descKey: 'studio.nodes.mcp.desc',
    icon: Server,
    category: 'Core',
  },
  {
    type: 'input',
    nameKey: 'studio.nodes.input.name',
    descKey: 'studio.nodes.input.desc',
    icon: ArrowRight,
    category: 'IO',
  },
  {
    type: 'output',
    nameKey: 'studio.nodes.output.name',
    descKey: 'studio.nodes.output.desc',
    icon: ArrowLeft,
    category: 'IO',
  },
  {
    type: 'custom-tool',
    nameKey: 'studio.nodes.customTool.name',
    descKey: 'studio.nodes.customTool.desc',
    icon: Code,
    category: 'Core',
  },
];

const categories: { id: string; labelKey: string }[] = [
  { id: 'Core', labelKey: 'studio.palette.core' },
  { id: 'IO', labelKey: 'studio.palette.io' },
  { id: 'Advanced', labelKey: 'studio.palette.advanced' },
];

interface NodePaletteProps {
  className?: string;
}

export function NodePalette({ className = '' }: NodePaletteProps) {
  const { t } = useTranslation();

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className={`studio-palette ${className}`}>
      {categories.map((category) => {
        const categoryNodes = nodeTypes.filter((node) => node.category === category.id);

        return (
          <div key={category.id}>
            <div className="studio-palette-cat">{t(category.labelKey)}</div>
            {categoryNodes.map((nodeType) => {
              const IconComponent = nodeType.icon;
              const description = t(nodeType.descKey);

              return (
                <div
                  key={nodeType.type}
                  className="studio-palette-item"
                  draggable
                  onDragStart={(event) => onDragStart(event, nodeType.type)}
                  title={description}
                >
                  <IconComponent className="studio-palette-ic" size={15} />
                  <div>
                    <div className="studio-palette-nm">{t(nodeType.nameKey)}</div>
                    <div className="studio-palette-desc">{description}</div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
