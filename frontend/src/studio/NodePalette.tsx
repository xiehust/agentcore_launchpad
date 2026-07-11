import React from 'react';
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
  label: string;
  icon: LucideIcon;
  description: string;
  category: string;
}

const nodeTypes: NodeTypeItem[] = [
  {
    type: 'agent',
    label: 'Agent Node',
    icon: Bot,
    description: 'Strands Agent with configurable model and settings',
    category: 'Core',
  },
  {
    type: 'orchestrator-agent',
    label: 'Orchestrator Agent',
    icon: Crown,
    description: 'Orchestrates multiple agents as tools for complex workflows',
    category: 'Advanced',
  },
  {
    type: 'swarm',
    label: 'Swarm Node',
    icon: Users,
    description: 'Multi-agent swarm with handoff capabilities and coordination',
    category: 'Advanced',
  },
  {
    type: 'tool',
    label: 'Tool Node',
    icon: Wrench,
    description: 'Built-in or custom tool for agent capabilities',
    category: 'Core',
  },
  {
    type: 'mcp-tool',
    label: 'MCP Server',
    icon: Server,
    description: 'Model Context Protocol server for external tools',
    category: 'Core',
  },
  {
    type: 'input',
    label: 'Input Node',
    icon: ArrowRight,
    description: 'Input prompt or data source',
    category: 'IO',
  },
  {
    type: 'output',
    label: 'Output Node',
    icon: ArrowLeft,
    description: 'Output response or data destination',
    category: 'IO',
  },
  {
    type: 'custom-tool',
    label: 'Custom Tool',
    icon: Code,
    description: 'Define custom tools with Python code',
    category: 'Core',
  },
];

const categories = ['Core', 'IO', 'Advanced'];

interface NodePaletteProps {
  className?: string;
}

export function NodePalette({ className = '' }: NodePaletteProps) {
  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className={`studio-palette ${className}`}>
      {categories.map((category) => {
        const categoryNodes = nodeTypes.filter((node) => node.category === category);

        return (
          <div key={category}>
            <div className="studio-palette-cat">{category}</div>
            {categoryNodes.map((nodeType) => {
              const IconComponent = nodeType.icon;

              return (
                <div
                  key={nodeType.type}
                  className="studio-palette-item"
                  draggable
                  onDragStart={(event) => onDragStart(event, nodeType.type)}
                  title={nodeType.description}
                >
                  <IconComponent className="studio-palette-ic" size={15} />
                  <div>
                    <div className="studio-palette-nm">{nodeType.label}</div>
                    <div className="studio-palette-desc">{nodeType.description}</div>
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
